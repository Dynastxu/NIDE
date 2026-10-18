import type { ElectronAPI } from '@electron-toolkit/preload'
import type { LogLevel } from '@shared/logger'
import type { I18nPayload, LocaleId } from '@shared/i18n'
import type { AppearancePreference } from '@shared/appearance'
import type { ThemeId, ThemePalette, ThemePayload } from '@shared/theme'
import type { ConfirmOptions, ConfirmRequest } from '@shared/confirm'
import type {
  ChapterListResult,
  CreateEntryRequest,
  CreateEntryResult,
  DeleteEntryRequest,
  DeleteEntryResult,
  DirReadResult,
  FileReadResult,
  FileWriteResult,
  ForeshadowingListResult,
  GalleryCreateRequest,
  GalleryCreateResult,
  GalleryListResult,
  GalleryRegistryUpdateRequest,
  GalleryRegistryUpdateResult,
  ProjectConfig,
  ProjectConfigPatch,
  ProjectConfigUpdateResult,
  ProjectListItem,
  ProjectOpenResult,
  ProjectPickMode,
  RenameEntryRequest,
  RenameEntryResult,
  WriteFileRequest
} from '@shared/project'
import type { Disposable, PluginDescriptor, PluginViewDescriptor } from '@shared/plugin-api'
import type { WindowAction, WindowState, WindowType } from '@shared/window'

/**
 * preload 在渲染进程里同步暴露的启动信息。
 *
 * 六项都必须**同步**可得，因为渲染进程要在第一帧、任何异步 IPC 之前就用到：
 * - locale 是 Monaco NLS 唯一需要的东西，而它必须在 monaco 模块求值前设好；
 * - appearance 决定设置页选中哪套主题。**必须同步**：主进程的广播只到得了建窗时
 *   已经存在的窗口，启动阶段先建好的窗口发不出广播、后建的也收不到；
 * - themePalette 说明当前配色是深是浅，要在首帧之前决定根元素挂不挂 `.theme-light`，
 *   晚一步就会先按内置深色画一帧；
 * - windowType 决定挂载哪个根组件，晚一步拿到就会先渲染错的界面；
 * - logLevel 决定是否接管 console，同理要在首个模块求值前拿到；
 * - projectPath 进窗口标题（标题栏第一帧就显示项目名，异步取会跳一下）。
 */
export interface NideBootInfo {
  /** 主进程建窗时定下的语言（BCP-47），例如 "zh-CN" */
  locale: LocaleId
  /** 用户选的主题（id + 是否跟随系统）。首帧就要喂进来，理由见上面的说明 */
  appearance: AppearancePreference
  /**
   * 当前这套配色是深还是浅。
   *
   * 渲染进程按它决定根元素挂不挂 `.theme-light`（浅色那套样式表靠这个类名生效）。
   */
  themePalette: ThemePalette
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
  /**
   * 重建根窗口。发出去就结束，不等回执（这个窗口自己会被销毁）。
   *
   * 会丢掉未保存的编辑内容，所以主进程会先问一次；调用方已经问过用户时传
   * `{ confirm: false }`（设置窗口与欢迎窗口的 RestartDialog 就是这种情形）。
   */
  restart: (options?: ConfirmOptions) => void
  /**
   * 退出整个应用（不是只关掉这个窗口）。同样不等回执。
   *
   * 确认框问在主进程的 `before-quit` 上，所以 macOS 的 ⌘Q 与关掉最后一个窗口之后
   * 的自动退出共用同一问；`{ confirm: false }` 表示调用方刚刚已经问过了。
   */
  quit: (options?: ConfirmOptions) => void
}

/**
 * 主题的渲染侧端口。
 *
 * 载荷是**主进程算好的结论**（可选哪些主题、现在用哪个、每个令牌是什么值），
 * 不是让渲染进程自己解析主题：读盘、瀑布补齐、令牌合法性都在主进程做完，
 * 渲染进程只负责把令牌写成 CSS 变量。
 */
export interface AppearanceAPI {
  /** 订阅主题变化：用户提交了、系统外观变了、别的窗口改了，都走这一条 */
  onChanged: (handler: (payload: ThemePayload) => void) => Disposable
  /** 拉一次当前载荷：可选主题列表 + 当前主题的令牌值 */
  get: () => Promise<ThemePayload>
  /** 提交一套主题。主进程校验并广播；不重建窗口，也不丢未保存的内容 */
  setTheme: (theme: ThemeId) => Promise<boolean>
}

/**
 * 行为级二次确认的渲染侧端口。
 *
 * 只有 `ui/ConfirmHost` 用它：它把主进程送来的问题画成浮层，再把回答送回去。
 * 「要不要问」不在这一层 —— 那是动作的性质，判断在主进程（见 main/confirm.ts）。
 */
export interface ConfirmAPI {
  /** 订阅主进程发来的确认请求。返回的 Disposable 用来退订 */
  onRequest: (handler: (request: ConfirmRequest) => void) => Disposable
  /** 回答一次询问。只有被问的那个窗口的回答会被采纳 */
  respond: (id: string, confirmed: boolean) => void
}

/**
 * 项目能力。判断全在主进程：目录存不存在这类事实渲染进程看不到。
 *
 * 打开 `pick('new')` 与 `pick('open')` 用的是同一个系统目录对话框，只有标题与
 * 起始目录不同 —— 「新建文件夹」由系统对话框自己提供。
 */
export interface ProjectAPI {
  list: () => Promise<ProjectListItem[]>
  /** 打开某个项目。当前有别的项目时会先问一次（换项目要重建窗口） */
  open: (dirPath: string, options?: ConfirmOptions) => Promise<ProjectOpenResult>
  pick: (mode: ProjectPickMode, options?: ConfirmOptions) => Promise<ProjectOpenResult>
  remove: (dirPath: string) => Promise<ProjectListItem[]>
  /** 关闭当前项目、回退到欢迎窗口。不返回回执：这个窗口会立刻被拆掉 */
  close: (options?: ConfirmOptions) => void
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
   * 读一个内容目录里的章节列表（含每一章的编号）。
   *
   * 与 readDir 分开：章节号写在文件开头的 frontmatter 里，主进程只读那一小段，
   * 而渲染进程没有「只读一段」的能力。目录里读不出编号的 `.md` 仍然列出来，
   * 只是 `chapter` 为 null。
   */
  readChapters: (dirPath: string) => Promise<ChapterListResult>
  /**
   * 读一个内容目录里的伏笔列表（名称 / 起始章节 / 结束章节 / 描述）。
   *
   * 与 readChapters 同一条边界：列表要扫一个目录并逐份取出字段，读不出字段的文件
   * 仍然列出来，只是名称回落到文件名。
   */
  readForeshadowing: (dirPath: string) => Promise<ForeshadowingListResult>
  /**
   * 新建文件 / 文件夹 —— 宿主唯一的写入入口。
   *
   * 目标目录由主进程从 `request.targetPath`（被右键的条目）推导，渲染进程指定
   * 不了任意写入位置。同名条目已存在时**不覆盖**，返回 `already-exists`。
   * 文件可以带一段初始内容（`request.content`），建出来就是完整的。
   */
  createEntry: (request: CreateEntryRequest) => Promise<CreateEntryResult>
  /**
   * 把正文写回一个文件（保存）。
   *
   * 只声明「写哪个文件」+「写什么」：保存不是另存为，覆盖的正是这个路径当初读出来的
   * 那个文件。路径跑出当前项目、目标已经不在了、是个链接、格式宿主不解码时，主进程
   * 拒绝并给出原因 —— 失败不抛异常。
   */
  writeFile: (request: WriteFileRequest) => Promise<FileWriteResult>
  /**
   * 给一个文件 / 文件夹改名 —— 与 createEntry 走同一条沙箱边界。
   *
   * 目录由主进程从 `request.targetPath`（被右键的条目）推导，渲染进程指定不了
   * 「改到哪个目录」，所以重命名变不成一次搬移。同名条目已存在时**不覆盖**，
   * 返回 `already-exists`。
   */
  renameEntry: (request: RenameEntryRequest) => Promise<RenameEntryResult>
  /**
   * 删除一个文件 / 文件夹。目录连同里面的东西一起删。
   *
   * 这是唯一**不可撤销**的写盘动作，所以二次确认挂在主进程的动作出口上
   * （见 main/confirm.ts）：谁发起都要过那一问，界面不自己弹框。用户拒了时返回
   * `{ ok: false, reason: 'cancelled' }`，那不是失败，界面不该提示什么。
   */
  deleteEntry: (request: DeleteEntryRequest, options?: ConfirmOptions) => Promise<DeleteEntryResult>
  /**
   * 读图鉴：内容目录下每个子目录一个图鉴（各自的字段表与条目），以及 `.nide` 里的
   * 注册表。
   *
   * 传的是图鉴内容目录的绝对路径，而它必须正是配置里那一个 —— 判据在主进程，渲染
   * 进程声明不了「哪个目录算图鉴目录」。失败返回带原因的结果，不抛异常。
   */
  readGalleries: (galleryRoot: string) => Promise<GalleryListResult>
  /**
   * 新建一个图鉴：一个目录 + 它的 `config.yml`（默认字段表）。
   *
   * 落点必须是配置里那个图鉴内容目录（主进程核对）；目录已存在时**不覆盖**，
   * 返回 `already-exists`。
   */
  createGallery: (request: GalleryCreateRequest) => Promise<GalleryCreateResult>
  /**
   * 改图鉴注册表：把某一个图鉴设成角色图鉴（章节表单的出场角色从它里面选）。
   *
   * 名字指向的目录不在时返回 `unknown-gallery`，什么都改。
   */
  updateGalleryRegistry: (
    request: GalleryRegistryUpdateRequest
  ) => Promise<GalleryRegistryUpdateResult | null>
  /**
   * 读当前项目的配置（`.nide/config.yml`）。没有项目时为 null。
   *
   * `.nide` 或配置文件缺失、坏掉时主进程会静默重建默认配置，所以调用方拿到的
   * 永远是一份可用的配置，不必为「配置不存在」写分支。
   */
  readConfig: () => Promise<ProjectConfig | null>
  /**
   * 更新当前项目的配置。补丁里只放要改的分区（例如 `{ chapters: { path: 'manuscript' } }`）；
   * **一项不合格就一项都不写**，返回的 config 是磁盘上那份没被改动的配置，界面据此
   * 说明哪一项被拒了。
   */
  updateConfig: (patch: ProjectConfigPatch) => Promise<ProjectConfigUpdateResult | null>
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
  /** 主题偏好（见 AppearanceAPI） */
  appearance: AppearanceAPI
  /** 行为级二次确认的渲染侧端口（只有 ConfirmHost 用） */
  confirm: ConfirmAPI
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
