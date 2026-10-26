import type { PluginManifest } from './manifest'

export interface Disposable {
  dispose(): void
}

/** 宿主暴露给插件的沙箱文件系统 API */
export interface FileSystemAPI {
  read(path: string): Promise<string>
  write(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  list(dir: string): Promise<string[]>
}

/** 宿主暴露给插件的编辑器交互 API（基于 Monaco） */
export interface EditorAPI {
  getCurrentFile(): Promise<string | null>
  notifyFileChanged(path: string, content: string): void
  showDiff(originalContent: string, modifiedContent: string): Promise<void>
}

/** 通用事件总线：宿主只负责转发，不关心事件内容 */
export interface EventBusAPI {
  emit(channel: string, ...args: unknown[]): void
  on(channel: string, handler: (...args: unknown[]) => void): Disposable
}

/** 插件配置存储 API */
export interface StorageAPI {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
}

/** 日志 API */
export interface Logger {
  error(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  debug(msg: string, ...args: unknown[]): void
}

/**
 * 插件上下文（宿主注入给插件的唯一接口）。
 *
 * 这里故意没有 `ui.registerView(loader)`：
 * 1) 函数无法跨进程传递 —— postMessage 走结构化克隆，函数会直接抛 DataCloneError；
 * 2) 渲染进程只能加载「它自己构建期打包进来的」模块，拿到磁盘路径也没法 import。
 * 插件要往界面加东西，唯一办法是在 manifest.json 的 contributes.views 里声明。
 */
export interface PluginContext {
  pluginId: string
  manifest: PluginManifest
  subscriptions: Disposable[]

  fs: FileSystemAPI
  editor: EditorAPI
  storage: StorageAPI
  log: Logger
  events: EventBusAPI
}

/** 插件入口的标准签名 */
export interface PluginModule {
  activate(context: PluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}
