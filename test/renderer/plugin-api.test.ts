import { afterEach, describe, expect, it } from 'vitest'
import { createPluginHostApi } from '@nide/sdk/plugin-views/plugin-api'

/**
 * 插件的受限 API 是在 preload 经 `contextBridge` 暴露的对象上再包一层。
 *
 * `contextBridge` 的属性**不可配置、不可写**，所以不能直接拿 `Proxy` 改写 get ——
 * 那会违反 Proxy 不变量并在运行时抛
 * `'get' on proxy: property ... is a read-only and non-configurable data property`。
 * 这里用 `Object.defineProperty` 造一个同样的桥对象，钉住「不再用 Proxy」这个实现。
 */
function frozenBridgeOf(source: Record<string, unknown>): Record<string, unknown> {
  const target: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    const value = source[key]
    const copied =
      value !== null && typeof value === 'object'
        ? frozenBridgeOf(value as Record<string, unknown>)
        : value
    Object.defineProperty(target, key, {
      value: copied,
      enumerable: true,
      writable: false,
      configurable: false
    })
  }
  return Object.freeze(target)
}

interface Calls {
  caller: string | null
  channels: string[]
}

function installBridge(): Calls {
  const calls: Calls = { caller: null, channels: [] }

  const bridge = frozenBridgeOf({
    setCaller: (id: string | null): void => {
      calls.caller = id
    },
    onEvent: (channel: string): { dispose: () => void } => {
      calls.channels.push(`${calls.caller ?? '-'}:${channel}`)
      return { dispose: () => {} }
    },
    emitEvent: (): void => {},
    aiProvider: {
      list: (): Promise<string | null> => Promise.resolve(calls.caller),
      fail: (): never => {
        throw new Error('boom')
      }
    }
  })

  ;(globalThis as { window?: unknown }).window = { hostAPI: bridge }
  return calls
}

const originalWindow = (globalThis as { window?: unknown }).window

afterEach(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
})

describe('createPluginHostApi', () => {
  it('在不可配置的桥对象上也能工作（Proxy 不变量回归）', () => {
    installBridge()
    expect(() => createPluginHostApi('demo.one')).not.toThrow()
  })

  it('调用期间带上插件 id，返回后清空', () => {
    const calls = installBridge()
    const api = createPluginHostApi('demo.two')

    const disposable = api.onEvent('echo:demo.ping', () => {})
    expect(calls.channels).toEqual(['demo.two:echo:demo.ping'])
    expect(calls.caller).toBeNull()
    expect(typeof disposable.dispose).toBe('function')
  })

  it('嵌套命名空间同样带 id，且引用稳定', () => {
    const calls = installBridge()
    const api = createPluginHostApi('demo.three')

    expect(api.aiProvider).toBe(api.aiProvider)
    expect(api.onEvent).toBe(api.onEvent)
    return expect(api.aiProvider.list())
      .resolves.toBe('demo.three')
      .then(() => {
        expect(calls.caller).toBeNull()
      })
  })

  it('不暴露 setCaller，插件不能自己伪装调用方', () => {
    installBridge()
    const api = createPluginHostApi('demo.four')
    expect((api as unknown as { setCaller?: unknown }).setCaller).toBeUndefined()
  })

  it('原方法抛错时也会清空调用方', () => {
    const calls = installBridge()
    const api = createPluginHostApi('demo.five')
    // 桥里的假方法不在真实类型表面里，测的是包装层的行为
    const failing = api.aiProvider as unknown as { fail: () => never }

    expect(() => failing.fail()).toThrow('boom')
    expect(calls.caller).toBeNull()
  })

  it('不同插件拿到不同的门面与包装函数', () => {
    installBridge()
    const first = createPluginHostApi('demo.six')
    const second = createPluginHostApi('demo.seven')

    expect(first.onEvent).not.toBe(second.onEvent)
    expect(first.aiProvider).not.toBe(second.aiProvider)
  })
})
