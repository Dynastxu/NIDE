import type { Context } from 'cordis'
import type { RpcNamespace } from './rpc.ts'

/**
 * host 的 Cordis 上下文扩展。
 *
 * 这里只挂**两样 Cordis 没有的东西**：
 * - `rpc`：宿主自己的 RPC 注册表（namespace -> handlers，带权限准入）；
 * - `hostEnv`：进程级只读环境（profile / home / userData / appRoot）。
 *
 * 名字用 `hostEnv` 而不是 `env`：Cordis 自己有一个 `ctx.env`（EnvData 服务），
 * 同名会被它的依赖守卫拦下（"cannot get property env without inject"）。
 *
 * 服务不再经过这里。它们走 Cordis 原生服务：
 * 提供方在 `apply` 里 `ctx.provide('project', store)`，并用 `declare module 'cordis'`
 * 给自己的 key 补类型；消费方用 `inject: ['project']` 声明依赖、直接 `ctx.project`。
 * 这样「谁先启动」由依赖图决定，不是由 profile 的行序决定。
 */

/** 服务之间共享的宿主环境（只读） */
export interface HostEnvironment {
  /** `NIDE_HOME` 下的 profile 目录 */
  profileDir: string
  profileName: string
  home: string
  /** Electron 的 userData；独立运行时是 `<home>/user-data` */
  userDataDir: string
  /** 应用根：内置插件包在 `<root>/packages/plugins` 下面 */
  appRoot: string
  /**
   * 本次启动用的 profile 行（`cordis.yml`）。
   *
   * 放这里是因为「哪些服务在跑」只有装配点知道：plugins 服务要用它回答
   * `plugins.core`（设置里的「核心包」列表），而不该自己再读一遍 profile。
   */
  profileRows: readonly {
    id: string
    name: string
    /** 核心行（宿主服务 / 平台层）：设置页单独展示，且不可启停 */
    core?: boolean
    description?: string
  }[]
}

/** 服务拿到的上下文 */
export interface NideContext extends Context {
  /** 注册一个 RPC 命名空间；返回注销函数（与 `ctx.effect` 语义一致） */
  rpc: {
    register(namespace: string, handlers: RpcNamespace): () => void
  }
  /** 进程级只读环境（不叫 env：那与 Cordis 自带的 EnvData 服务冲突） */
  hostEnv: HostEnvironment
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
  const context = ctx as NideContext
  define(context, 'rpc', options.rpc)
  define(context, 'hostEnv', options.env)
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

/**
 * 把 `rpc` / `hostEnv` 变成**真正的 Cordis 服务**。
 *
 * 根上下文上的 defineProperty 只够宿主自己的代码用：插件（包括服务）跑在各自的
 * fiber 里，Cordis 只允许它访问 `inject` 声明过的 key —— 往 `ctx` 上贴一个普通
 * 属性，插件读到时会被依赖守卫拦下（"cannot get property hostEnv without inject"）。
 *
 * 所以这两个值必须在插件树里 `ctx.provide` 一次，由宿主在挂载 profile 之前先
 * 挂上 `nide:host` 这一行。
 */
export function hostServices(options: InstallOptions): {
  name: string
  apply(ctx: Context): void
} {
  return {
    name: 'nide:host',
    apply(ctx) {
      ctx.provide('rpc', options.rpc)
      ctx.provide('hostEnv', options.env)
    }
  }
}
