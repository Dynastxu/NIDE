import { describe, expect, it, vi } from 'vitest'
import { RpcRegistry } from '../../packages/host/src/rpc.ts'

/**
 * host 的 RPC 注册表。
 *
 * 这一层是 shell / 渲染进程访问 host 的唯一入口，之前没有用例 —— 而它最容易出错的
 * 地方恰恰是「出错时怎么回答」：未知 namespace、未知方法、handler 抛错，三种都必须
 * 变成**回包**而不是拒绝，否则调用方会一直等到超时。渲染进程连的是 MessagePort，
 * 一个不落地的 await 就是界面上永远转圈的加载态。
 */

function request(
  namespace: string,
  method: string,
  args: unknown[] = []
): Parameters<RpcRegistry['invoke']>[0] {
  return { type: 'rpc', id: 'r1', namespace, method, args }
}

describe('RpcRegistry', () => {
  it('调用注册过的方法，回包带同一个 id 与结果', async () => {
    const rpc = new RpcRegistry()
    rpc.register('demo', { add: (a, b) => Number(a) + Number(b) })

    await expect(rpc.invoke(request('demo', 'add', [1, 2]))).resolves.toEqual({
      type: 'rpc-result',
      id: 'r1',
      ok: true,
      result: 3
    })
  })

  it('异步 handler 会等结果（流式之外的唯一形状）', async () => {
    const rpc = new RpcRegistry()
    rpc.register('demo', {
      later: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1))
        return 'done'
      }
    })

    const response = await rpc.invoke(request('demo', 'later'))
    expect(response).toMatchObject({ ok: true, result: 'done' })
  })

  it('未知 namespace 回 unknown-namespace，而不是抛', async () => {
    const response = await new RpcRegistry().invoke(request('nope', 'x'))
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'unknown-namespace' }
    })
  })

  it('未知方法回 unknown-method', async () => {
    const rpc = new RpcRegistry()
    rpc.register('demo', { known: () => 1 })

    expect(await rpc.invoke(request('demo', 'missing'))).toMatchObject({
      ok: false,
      error: { code: 'unknown-method' }
    })
  })

  it('handler 抛错回 handler-error，消息透传', async () => {
    const rpc = new RpcRegistry()
    rpc.register('demo', {
      boom: () => {
        throw new Error('炸了')
      }
    })

    expect(await rpc.invoke(request('demo', 'boom'))).toMatchObject({
      ok: false,
      error: { code: 'handler-error', message: '炸了' }
    })
  })

  it('非 Error 的抛出也有可读消息', async () => {
    const rpc = new RpcRegistry()
    rpc.register('demo', {
      boom: () => {
        throw '字符串'
      }
    })

    expect(await rpc.invoke(request('demo', 'boom'))).toMatchObject({
      ok: false,
      error: { code: 'handler-error', message: '字符串' }
    })
  })

  it('args 不是数组时按空参数调用（坏载荷不炸）', async () => {
    const rpc = new RpcRegistry()
    const handler = vi.fn(() => 'ok')
    rpc.register('demo', { ping: handler })

    const response = await rpc.invoke({
      type: 'rpc',
      id: 'r1',
      namespace: 'demo',
      method: 'ping',
      args: 'oops'
    } as never)

    expect(response).toMatchObject({ ok: true, result: 'ok' })
    expect(handler).toHaveBeenCalledWith()
  })

  it('注销只撤掉自己那一份（重复注册时保留新的）', () => {
    const rpc = new RpcRegistry()
    const disposeOld = rpc.register('demo', { ping: () => 'old' })
    rpc.register('demo', { ping: () => 'new' })

    disposeOld()

    return expect(rpc.invoke(request('demo', 'ping'))).resolves.toMatchObject({ result: 'new' })
  })

  it('注销后调用回到 unknown-namespace', async () => {
    const rpc = new RpcRegistry()
    const dispose = rpc.register('demo', { ping: () => 'ok' })
    dispose()

    expect(await rpc.invoke(request('demo', 'ping'))).toMatchObject({
      ok: false,
      error: { code: 'unknown-namespace' }
    })
  })
})
