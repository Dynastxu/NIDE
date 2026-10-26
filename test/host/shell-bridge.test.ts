import { afterEach, describe, expect, it, vi } from 'vitest'
import { ShellBridge } from '../../packages/host/src/shell.ts'
import type { ShellCall, ShellCallResult } from '../../packages/contracts/src/host-rpc/index.ts'

/**
 * host 侧的 `ctx.shell` 桥（反向 RPC）。
 *
 * 这里不碰 Electron：桥只负责「把请求发出去、等回包、超时/断开时明确失败」。
 * 真正的能力（nativeTheme / safeStorage）在 shell 那边，由 `handleShellCall` 执行。
 */

/** 记录发出去的请求；返回一个和请求 id 对得上的成功/失败回包 */
function capture(): { sent: ShellCall[]; ok: (result: unknown) => ShellCallResult } {
  const sent: ShellCall[] = []
  return {
    sent,
    ok: (result) => ({ type: 'shell-result', id: sent[sent.length - 1].id, ok: true, result })
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ShellBridge', () => {
  it('没有挂到 shell 上时 call 直接 reject，而不是永远挂着', async () => {
    const bridge = new ShellBridge()

    expect(bridge.attached).toBe(false)
    await expect(bridge.call('nativeTheme.shouldUseDarkColors')).rejects.toThrow(/not attached/)
  })

  it('attach 之后发出 shell-call，回包成功后 resolve', async () => {
    const bridge = new ShellBridge()
    const harness = capture()
    bridge.attach((message) => harness.sent.push(message as ShellCall))

    const promise = bridge.call<boolean>('nativeTheme.shouldUseDarkColors')

    expect(harness.sent).toHaveLength(1)
    expect(harness.sent[0]).toMatchObject({
      type: 'shell-call',
      method: 'nativeTheme.shouldUseDarkColors',
      args: []
    })

    expect(bridge.settle(harness.ok(true))).toBe(true)
    await expect(promise).resolves.toBe(true)
  })

  it('失败回包 reject，并带上 code', async () => {
    const bridge = new ShellBridge()
    const harness = capture()
    bridge.attach((message) => harness.sent.push(message as ShellCall))

    const promise = bridge.call('safeStorage.encrypt', ['secret'])
    bridge.settle({
      type: 'shell-result',
      id: harness.sent[0].id,
      ok: false,
      error: { code: 'shell-call-failed', message: 'safeStorage is not available' }
    })

    await expect(promise).rejects.toThrow('safeStorage is not available')
  })

  it('超时 reject（shell 卡住 / 窗口全关）', async () => {
    vi.useFakeTimers()
    const bridge = new ShellBridge()
    bridge.attach(() => {
      // 故意不回包
    })

    const promise = bridge.call('nativeTheme.setSource', ['dark'], 1_000)
    const assertion = expect(promise).rejects.toThrow(/timed out/)
    await vi.advanceTimersByTimeAsync(1_100)
    await assertion
  })

  it('detach 时挂着的调用立刻失败', async () => {
    const bridge = new ShellBridge()
    bridge.attach(() => {})

    const promise = bridge.call('nativeTheme.shouldUseDarkColors')
    bridge.detach('shell went away')

    await expect(promise).rejects.toThrow('shell went away')
    expect(bridge.attached).toBe(false)
  })

  it('回包没人等（超时之后才到）时 settle 返回 false', () => {
    const bridge = new ShellBridge()

    expect(bridge.settle({ type: 'shell-result', id: 'nope', ok: true, result: 1 })).toBe(false)
  })

  it('同一个回包只结算一次', async () => {
    const bridge = new ShellBridge()
    const harness = capture()
    bridge.attach((message) => harness.sent.push(message as ShellCall))

    const promise = bridge.call<number>('safeStorage.status')
    const result = harness.ok(1)

    expect(bridge.settle(result)).toBe(true)
    expect(bridge.settle(result)).toBe(false)
    await expect(promise).resolves.toBe(1)
  })
})
