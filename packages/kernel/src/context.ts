import type { Context } from '@deepseek-ai/cordis'
import type { RpcNamespace } from './rpc.ts'

/**
 * host 的 Cordis 上下文扩展（阶段 3 的地基）。
 *
 * 目标：**服务不再 import 内核**。一个服务包只需要实现
 * `{ name, apply(ctx) }`，然后用 `ctx.rpc.register(...)` 暴露 RPC、
 * 用 `ctx.services.provide/require` 互相取用、用 `ctx.env` 拿路径。
 *
 * 这里刻意不碰 Cordis 内部的服务/依赖注入机制（`ctx.provide` / `inject` 的语义
 * 还在演进）：先用一层很小的、看得懂的注册表把装配点从「800 行的 index.ts」
 * 挪到「每个服务自己的 apply」。等 loader 能直接加载包标识符之后，这一层可以
 * 平滑换成 Cordis 原生服务。
 */

/** 服务之间共享的宿主环境（只读） */
export interface HostEnvironment {
  /** `NIDE_HOME` 下的 profile 目录 */
  profileDir: string
  profileName: string
  home: string
  /** Electron 的 userData；独立运行时是 `<home>/user-data` */
  userDataDir: string
  /** 应用根：`<root>/plugins/builtin` 在它下面 */
  appRoot: string
}

/**
 * 服务注册表。
 *
 * `provide` 覆盖同名时**抛错**而不是静默替换：两个包抢同一个服务名是装配错误，
 * 越早炸越好。`require` 找不到也抛 —— 依赖缺失必须在启动期暴露。
 */
export interface ServiceRegistry {
  provide<T>(name: string, value: T): T
  require<T>(name: string): T
  has(name: string): boolean
}

/** 服务拿到的上下文 */
export interface NideContext extends Context {
  /** 注册一个 RPC 命名空间；返回注销函数（与 `ctx.effect` 语义一致） */
  rpc: {
    register(namespace: string, handlers: RpcNamespace): () => void
  }
  services: ServiceRegistry
  env: HostEnvironment
}

export interface InstallOptions {
  /** 内核持有的注册表（也是 transport 分发的那个） */
  rpc: NideContext['rpc']
  env: HostEnvironment
}

/**
 * 把扩展挂到 Cordis 上下文上。
 *
 * 用 `Object.defineProperty` 而不是直接赋值：Cordis 的 Context 是代理对象，
 * 直接赋值可能落到错误的 target 上；属性定为不可枚举 + 只读，避免被服务误改。
 */
export function installNideContext(ctx: Context, options: InstallOptions): NideContext {
  const services: ServiceRegistry = {
    provide<T>(name: string, value: T): T {
      if (services.has(name)) throw new Error(`service already registered: ${name}`)
      provided.set(name, value)
      return value
    },
    require<T>(name: string): T {
      const value = provided.get(name)
      if (value === undefined) throw new Error(`service not registered: ${name}`)
      return value as T
    },
    has: (name) => provided.has(name)
  }

  const provided = new Map<string, unknown>()

  const context = ctx as NideContext
  define(context, 'rpc', options.rpc)
  define(context, 'services', services)
  define(context, 'env', options.env)

  return context
}

function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: false,
    enumerable: false,
    configurable: false
  })
}
