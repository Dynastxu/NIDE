/**
 * 插件**后端**（主进程半）的契约。
 *
 * 插件清单里的 `main` 指向一个 ESM 文件，默认导出 `PluginBackend`；宿主把它
 * 放进独立子进程里跑（`packages/services/plugins/src/backend/`），文件 / 子进程
 * 权限由 Node 的 `--permission` 强制。
 *
 * 这是给插件作者看的类型，运行时由宿主注入 —— 插件不需要（也不应该）自己
 * import 宿主的实现。
 */

export interface PluginBackendPaths {
  /** 宿主 userData 目录（Electron 的 `app.getPath('userData')`） */
  userData: string
  /** 这个插件的目录（绝对路径） */
  pluginDir: string
  /** 可用的临时目录 */
  temp: string
  /** 当前用户主目录 */
  home: string
}

export interface PluginBackendLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** 后端插件拿到的宿主对象 */
export interface PluginBackendHost {
  /** 清单里的插件 id */
  id: string
  paths: PluginBackendPaths
  log: PluginBackendLogger
  /**
   * 注册一个供渲染进程调用的方法（宿主 RPC `plugin.call`）。
   *
   * 返回注销函数；插件停用 / 后端退出时宿主会自动清掉，不需要自己再调。
   * 同名方法在一个插件里只能注册一次。
   */
  handle(method: string, handler: (params?: unknown) => unknown | Promise<unknown>): () => void
}

/**
 * 插件后端的默认导出形状。
 *
 * 也可以直接默认导出一个函数，等价于 `{ activate: fn }`。
 */
export interface PluginBackend {
  /** 后端启动；可以返回一个清理函数（与 `deactivate` 二选一） */
  activate(host: PluginBackendHost): unknown | Promise<unknown>
  /** 后端停止（宿主发 dispose 时调用） */
  deactivate?(): unknown | Promise<unknown>
}
