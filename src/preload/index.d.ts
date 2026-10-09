import type { ElectronAPI } from '@electron-toolkit/preload'
import type { LogLevel } from '@shared/logger'
import type { I18nPayload, LocaleId } from '@shared/i18n'
import type {
  CreateEntryRequest,
  CreateEntryResult,
  DirReadResult,
  FileReadResult,
  ProjectListItem,
  ProjectOpenResult,
  ProjectPickMode
} from '@shared/project'
import type { Disposable, PluginDescriptor, PluginViewDescriptor } from '@shared/plugin-api'
import type { WindowAction, WindowState, WindowType } from '@shared/window'

/**
 * preload 在渲染进程里同步暴露的启动信息。
 *
 * 四项都必须**同步**可得，因为渲染进程要在第一帧、任何异步 IPC 之前就用到：
 * - locale 是 Monaco NLS 唯一需要的东西，而它必须在 monaco 模块求值前设好；
 * - windowType 决定挂载哪个根组件，晚一步拿到就会先渲染错的界面；
 * - logLevel 决定是否接管 console，同理要在首个模块求值前拿到；
 * - projectPath 进窗口标题（标题栏第一帧就显示项目名，异步取会跳一下）。
 */
export interface NideBootInfo {
  /** 主进程建窗时定下的语言（BCP-47），例如 "zh-CN" */
  locale: LocaleId
  /** 这个窗口是哪种窗口。渲染进程据此选根组件 */
  windowType: WindowType
  /** 主进程解析出的日志级别阈值。渲染进程只读结论，不重新解析环境变量 */
  logLevel: LogLevel
  /** 当前项目目录；没有项目（欢迎窗口）时为 null */
  projectPath: string | null
}

/**
 * 渲染进程的日志出口。
 *
 * 只暴露四个级别方法，不暴露通道名 —— 渲染进程拿到通道名就能往任意 channel
 * 发任意载荷，那是一条伪造 IPC 的路。
 */
export interface RendererLoggerAPI {
  error: (text: string, fields?: Record<string, unknown>) => void
  warn: (text: string, fields?: Record<string, unknown>) => void
  info: (text: string, fields?: Record<string, unknown>) => void
  debug: (text: string, fields?: Record<string, unknown>) => void
}

/**
 * 窗口本体能力。每个窗口都有，和「宿主业务能力」刻意分开：
 * 最小化/最大化/关闭是窗口自己的事，跟插件、编辑器没关系。
 */
export interface WindowAPI {
  /** 同步读一次窗口状态。异步会让第一帧画出错的按钮 */
  getState: () => WindowState
  onStateChange: (handler: (state: WindowState) => void) => Disposable
  action: (action: WindowAction) => void
  open: (type: WindowType) => Promise<void>
  /** 重建根窗口。发出去就结束，不等回执（这个窗口自己会被销毁） */
  restart: () => void
  /** 退出整个应用（不是只关掉这个窗口）。同样不等回执 */
  quit: () => void
}

/**
 * 项目能力。判断全在主进程：目录存不存在这类事实渲染进程看不到。
 *
 * 打开 `pick('new')` 与 `pick('open')` 用的是同一个系统目录对话框，只有标题与
 * 起始目录不同 —— 「新建文件夹」由系统对话框自己提供。
 */
export interface ProjectAPI {
  list: () => Promise<ProjectListItem[]>
  open: (dirPath: string) => Promise<ProjectOpenResult>
  pick: (mode: ProjectPickMode) => Promise<ProjectOpenResult>
  remove: (dirPath: string) => Promise<ProjectListItem[]>
  /** 关闭当前项目、回退到欢迎窗口。不返回回执：这个窗口会立刻被拆掉 */
  close: () => void
  /**
   * 读项目里的一层目录（文件树的一层）。
   *
   * 范围由主进程对照**当前项目**判断：渲染进程只声明想读哪儿，声明不了允许读到
   * 哪儿。失败返回带原因的结果，不抛异常。
   */
  readDir: (dirPath: string) => Promise<DirReadResult>
  /** 读一个纯文本 / Markdown 文件。不支持的格式由主进程拒绝 */
  readFile: (filePath: string) => Promise<FileReadResult>
  /**
   * 新建文件 / 文件夹 —— 宿主唯一的写入入口。
   *
   * 目标目录由主进程从 `request.targetPath`（被右键的条目）推导，渲染进程指定
   * 不了任意写入位置。同名条目已存在时**不覆盖**，返回 `already-exists`。
   */
  createEntry: (request: CreateEntryRequest) => Promise<CreateEntryResult>
}

export interface HostAPI {
  getPluginViews: () => Promise<PluginViewDescriptor[]>
  getPlugins: () => Promise<PluginDescriptor[]>
  setPluginEnabled: (pluginId: string, enabled: boolean) => Promise<void>
  getDisabledPlugins: () => Promise<string[]>
  onPluginEnabledChanged: (handler: (pluginId: string, enabled: boolean) => void) => Disposable
  getI18n: () => Promise<I18nPayload>
  setLocale: (locale: LocaleId) => Promise<void>
  emitEvent: (channel: string, ...args: unknown[]) => void
  onEvent: (channel: string, handler: (...args: unknown[]) => void) => Disposable
  notifyEditorChange: (filePath: string, content: string) => void
  onShowDiff: (handler: (original: string, modified: string) => void) => Disposable
  onFileChanged: (handler: (filePath: string, content: string) => void) => Disposable
  showStripeMenu: (showTitles: boolean) => Promise<boolean>
  /** 日志出口。渲染进程所有日志都经它汇总到主进程的同一份文件 */
  log: RendererLoggerAPI
  window: WindowAPI
  /** 打开过的项目 / 当前项目 */
  projects: ProjectAPI
  reloadPlugin: (pluginId: string) => Promise<void>
}

declare global {
  interface Window {
    electron: ElectronAPI
    hostAPI: HostAPI
    __NIDE_BOOT__: NideBootInfo
  }
}

export {}
