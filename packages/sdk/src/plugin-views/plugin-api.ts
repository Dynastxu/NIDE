/**
 * 插件 UI 的**受限宿主 API**。
 *
 * 插件视图里不要直接用 `window.hostAPI`：那个对象属于宿主，调用时不会带调用方
 * 身份，宿主也就无法按插件的权限声明（manifest 的 `permissions`）做检查。
 * 用 `useHost().api` 拿到的对象是同一批方法的包装 —— 每次调用前把当前插件 id
 * 告诉 preload，宿主据此判断 `fs` 作用域等。
 *
 * 包装是**同步**的：`setCaller` → 原方法 → `setCaller(null)`。宿主方法在返回
 * Promise 之前就已经把请求发出去了，所以异步结果回来时不会算到别的插件头上。
 *
 * 边界：这是声明式的权限边界，不是 JS 沙箱。插件 bundle 与宿主 UI 跑在同一个
 * 渲染进程里，直接摸 `window.hostAPI` 仍然能绕过（与 mics 对渲染进程插件的
 * 说明一致）。要真正的隔离，得等插件后端有独立进程。
 */

/** 插件能看到的宿主 API：去掉只有宿主/SDK 自己用的 `setCaller` */
export type PluginHostApi = Omit<typeof window.hostAPI, 'setCaller'>

interface ScopeCache {
  /** 子命名空间对象 -> proxy */
  objects: WeakMap<object, object>
  /** 原函数 -> 包装后的函数（稳定引用，插件把它放进依赖数组也不会反复重跑） */
  functions: WeakMap<object, (...args: unknown[]) => unknown>
}

const caches = new Map<string, ScopeCache>()

/**
 * 为一个插件 id 造（并缓存）受限 API。
 *
 * 缓存按对象 / 函数身份：`hostAPI` 里的子命名空间（`projects` / `aiProvider` …）
 * 与它们的方法是稳定对象，每次渲染都新建 proxy 会让把它们放进依赖数组的插件
 * 反复重跑。
 */
export function createPluginHostApi(pluginId: string): PluginHostApi {
  // 没有 preload 桥（测试 / SSR / 构建期）时给一个空对象：插件视图在这类环境里
  // 本来也用不到宿主 API，不该因为模块被 import 就炸。
  if (typeof window === 'undefined' || !window.hostAPI) return {} as PluginHostApi

  let cache = caches.get(pluginId)
  if (!cache) {
    cache = { objects: new WeakMap(), functions: new WeakMap() }
    caches.set(pluginId, cache)
  }

  const scoped = (target: object): object => {
    const cached = cache.objects.get(target)
    if (cached) return cached

    const proxy = new Proxy(target, {
      get(object, property) {
        // 不让插件把自己伪装成别的调用方
        if (property === 'setCaller') return undefined

        const value = Reflect.get(object, property)
        if (typeof value === 'function') {
          const fn = value as (...rest: unknown[]) => unknown
          const wrapped = cache.functions.get(fn)
          if (wrapped) return wrapped

          const wrapper = (...args: unknown[]): unknown => {
            window.hostAPI.setCaller(pluginId)
            try {
              return fn.apply(window.hostAPI, args)
            } finally {
              window.hostAPI.setCaller(null)
            }
          }
          cache.functions.set(fn, wrapper)
          return wrapper
        }
        if (value !== null && typeof value === 'object') return scoped(value as object)
        return value
      }
    })

    cache.objects.set(target, proxy)
    return proxy
  }

  return scoped(window.hostAPI) as PluginHostApi
}
