import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  DEFAULT_LOG_LEVEL,
  createLogger,
  normalizeFields,
  parseLogLevel,
  type LogMessage,
  type Logger
} from '@nide/contracts/logger'
import { DEFAULT_LOCALE, LOCALE_ARG_PREFIX } from '@nide/contracts/i18n'
import {
  APPEARANCE_ARG_PREFIX,
  APPEARANCE_CHANNEL,
  THEME_PALETTE_ARG_PREFIX,
  normalizeAppearancePreference
} from '@nide/contracts/appearance'
import { CONFIRM_CHANNELS } from '@nide/contracts/confirm'
import { HOST_PORT_CHANNEL, isRpcResponse } from '@nide/contracts/host-rpc'
import { HOST_CHANNELS, HOST_EVENT_CHANNELS } from '@nide/contracts/host'
import { AI_PROVIDER_CHANNELS } from '@nide/contracts/ai-provider'
import {
  PROJECT_ARG_PREFIX,
  PROJECT_CHANNELS,
  PROJECT_CONFIG_CHANNELS,
  PROJECT_FILE_CHANNELS,
  PROJECT_GALLERY_CHANNELS,
  PROJECT_OVERVIEW_CHANNELS
} from '@nide/contracts/project'
import {
  LOG_LEVEL_ARG_PREFIX,
  WINDOW_ARG_PREFIX,
  WINDOW_CHANNELS,
  isWindowType,
  type WindowAction,
  type WindowState,
  type WindowType
} from '@nide/contracts/window'
import type { I18nPayload, LocaleId } from '@nide/contracts/i18n'
import type {
  ChatOpenRequest,
  ChatOpenResult,
  ChatStreamEvent,
  ProviderSummary,
  RemoveProviderResult,
  SaveProviderRequest,
  SaveProviderResult,
  TestProviderRequest,
  TestProviderResult
} from '@nide/contracts/ai-provider'
import type { AppearancePreference } from '@nide/contracts/appearance'
import type { ThemeId, ThemePalette, ThemePayload } from '@nide/contracts/theme'
import type { ConfirmOptions, ConfirmRequest } from '@nide/contracts/confirm'
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
  OverviewListResult,
  OverviewRoleUpdateRequest,
  OverviewRoleUpdateResult,
  ProjectConfig,
  ProjectConfigPatch,
  ProjectConfigUpdateResult,
  ProjectListItem,
  ProjectOpenResult,
  ProjectPickMode,
  RenameEntryRequest,
  RenameEntryResult,
  WriteFileRequest
} from '@nide/contracts/project'
import type {
  Disposable,
  PluginDescriptor,
  ClientBundleDescriptor,
  PluginInstallResult,
  PluginRemoveResult
} from '@nide/contracts/plugin-api'
import type { CorePackage } from '@nide/contracts/plugin-api/core-packages'

// 通用事件总线（渲染进程侧）
const listeners = new Map<string, Set<(...args: unknown[]) => void>>()

ipcRenderer.on(HOST_CHANNELS.event, (_event, channel: string, ...args: unknown[]) => {
  listeners.get(channel)?.forEach((handler) => handler(...args))
})

/**
 * 启动语言：从主进程创建窗口时传入的启动参数中**同步**读取。
 *
 * 仅供 Monaco 使用 —— Monaco 模块必须在
 * 求值之前获取语言设置，而该初始化路径上不存在执行 await 的时机。
 * 完整的词条表仍通过 host:get-i18n 异步获取，两者互不冲突：此处仅返回
 * 一个语言标识字符串。
 * @see packages/client-kit/src/monaco-env.ts
 */
function readBootLocale(): LocaleId {
  const arg = process.argv.find((item) => item.startsWith(LOCALE_ARG_PREFIX))
  return arg ? arg.slice(LOCALE_ARG_PREFIX.length) : DEFAULT_LOCALE
}

/**
 * 启动偏好：选了哪套主题、要不要跟随系统。和 locale / window type 一样从启动参数里
 * 同步读。
 *
 * 为什么不靠主进程的广播：广播只到得了"此刻已经存在"的窗口（见 shared/appearance
 * 的 APPEARANCE_ARG_PREFIX 说明）。启动阶段窗口是一个一个建的，先建好的发不出广播、
 * 后建的也收不到，于是设置页会显示成"默认主题 + 跟随系统没勾"。
 */
function readBootAppearance(): AppearancePreference {
  const arg = process.argv.find((item) => item.startsWith(APPEARANCE_ARG_PREFIX))
  const value = arg ? arg.slice(APPEARANCE_ARG_PREFIX.length) : ''
  const [theme, followSystem] = value.split(':')

  // 主题 id 只在「空」时回落：它存不存在由主进程回答（找不到会走 fallbackFrom），
  // 这里多判一次只会让两端的判断分叉
  return normalizeAppearancePreference({ theme, followSystem: followSystem === '1' })
}

/**
 * 启动配色深浅：当前这套主题是深还是浅，同样从启动参数里同步读。
 *
 * 这是**首帧配色**的唯一依据：渲染进程要在画出任何东西之前决定根元素挂不挂
 * `.theme-light`（浅色那套样式表靠这个类名生效），晚一步就会先按深色画一帧、
 * 选浅色时表现为整屏闪一下。
 *
 * 缺失或写坏时按**深色**算：深色就是组件里写死的那套色阶，也就是"什么都不挂"的
 * 默认状态 —— 这个回落永远不会画出错误颜色。
 */
function readBootPalette(): ThemePalette {
  const arg = process.argv.find((item) => item.startsWith(THEME_PALETTE_ARG_PREFIX))
  const value = arg ? arg.slice(THEME_PALETTE_ARG_PREFIX.length) : ''
  return value === 'light' ? 'light' : 'dark'
}

/**
 * 启动窗口种类：和 locale 一样从建窗时喂进来的启动参数里同步读。
 *
 * 为什么不走 IPC：渲染进程要靠它在**挂载之前**决定加载哪个根组件，
 * 而「先渲染主的、再异步换成设置界面」既多一帧闪烁，又得让两个界面同时
 * 假设自己可能被卸掉。启动参数是唯一在首帧之前就确定的东西。
 */
function readBootWindowType(): WindowType {
  const arg = process.argv.find((item) => item.startsWith(WINDOW_ARG_PREFIX))
  const value = arg ? arg.slice(WINDOW_ARG_PREFIX.length) : ''
  return isWindowType(value) ? value : 'main'
}

/**
 * 启动日志级别：和 locale / window type 一样从启动参数里同步读。
 *
 * 级别由主进程解析（见 main/logger），这里只读结论 —— 两端各解析一遍环境变量
 * 迟早会出现「文件里有 debug、控制台里没有」这种半边生效的结果。
 */
function readBootLogLevel(): string {
  const arg = process.argv.find((item) => item.startsWith(LOG_LEVEL_ARG_PREFIX))
  return arg ? arg.slice(LOG_LEVEL_ARG_PREFIX.length) : DEFAULT_LOG_LEVEL
}

/**
 * 启动项目路径：和 locale / window type 一样从启动参数里同步读。
 *
 * 主窗口的标题栏第一帧就要显示项目名，异步 IPC 会先渲染一版没有项目名的标题
 * 再跳一下。没有项目时是 null —— 欢迎窗口那条路径上就没有项目。
 */
function readBootProjectPath(): string | null {
  const arg = process.argv.find((item) => item.startsWith(PROJECT_ARG_PREFIX))
  const value = arg ? arg.slice(PROJECT_ARG_PREFIX.length) : ''
  return value.length > 0 ? value : null
}

const logLevel = parseLogLevel(readBootLogLevel())

/**
 * 日志出口：预加载与渲染进程的日志都由这里发往主进程。
 *
 * 为什么不让 electron-log 自己接管渲染进程：它的 renderer 实现要在
 * `window.__electronLog` 上找到出口，而那个出口最终也是这一条 IPC ——
 * 宿主显式写出来，就少一层「库在什么时机把全局挂上去」的不确定性。
 * 归一化后发送的理由见 shared/logger 的 normalizeFields：结构化克隆拒绝
 * Error 与循环引用，不归一化会让日志转发本身变成崩溃点。
 */
function sendLog(message: LogMessage): void {
  ipcRenderer.send(WINDOW_CHANNELS.log, {
    date: message.date.toISOString(),
    level: message.level,
    scope: message.scope,
    text: message.text,
    fields: normalizeFields(message.fields)
  })
}

const preloadLogger: Logger = createLogger('preload', { write: sendLog }, logLevel)

/**
 * 窗口按钮的后端。
 *
 * 窗口是无边框的，三个系统按钮由渲染进程自绘 —— 这个对象就是它们唯一的出口。
 * getState 刻意是**同步**的：异步版本会让第一帧把「最大化」画成「还原」再跳一下。
 */
const windowAPI = {
  getState: (): WindowState => {
    const state = ipcRenderer.sendSync(WINDOW_CHANNELS.stateSync) as WindowState | null
    // 主进程那边查不到窗口（理论上不该发生）时给一个安全的默认值：
    // 「未最大化、有焦点」正好画出最常见的那个按钮组合，不会让标题栏空掉
    return state ?? { maximized: false, focused: true }
  },

  /** 窗口状态变化：最大化/还原、获得/失去焦点 */
  onStateChange: (handler: (state: WindowState) => void): Disposable => {
    const wrapped = (_e: unknown, state: WindowState): void => handler(state)
    ipcRenderer.on(WINDOW_CHANNELS.stateChanged, wrapped)
    return {
      dispose: () => ipcRenderer.off(WINDOW_CHANNELS.stateChanged, wrapped)
    }
  },

  /** 发一个窗口动作。单向 send：结果由 onStateChange 推回来，不需要回执 */
  action: (action: WindowAction): void => {
    ipcRenderer.send(WINDOW_CHANNELS.action, action)
  },

  /** 打开另一个窗口（种类在 shared/window 里登记） */
  open: (type: WindowType): Promise<void> => ipcRenderer.invoke(WINDOW_CHANNELS.open, type),

  /**
   * 重建主窗口（设置界面的「立即重启」）。走和切语言同一条实现。
   *
   * 单向 send，不返回 Promise：这个窗口会在重建过程中被销毁，等一个永远到不了的
   * 应答没有意义。发出去就不管了。
   *
   * 调用方**已经问过**用户时传 `{ confirm: false }`（设置窗口与欢迎窗口的
   * RestartDialog 就是这种情形：它问的是「要不要现在重启」，主进程再问一遍
   * 只会让人怀疑自己刚才点的是什么）。
   */
  restart: (options?: ConfirmOptions): void => {
    ipcRenderer.send(WINDOW_CHANNELS.restart, options)
  },

  /**
   * 退出应用（标题栏「文件 -> 退出」）。
   *
   * 与 `action('close')` 不同：那个只关掉当前这个窗口，这个结束整个应用。同样用
   * 单向 send —— 应用马上就没了，回执没有任何接收方。
   *
   * 确认框由主进程在 `before-quit` 上问（见 main/lifecycle.ts），所以 macOS 的 ⌘Q
   * 与关掉最后一个窗口之后的自动退出走的是同一问；这里传 `{ confirm: false }`
   * 表示调用方刚刚已经问过用户了。
   */
  quit: (options?: ConfirmOptions): void => {
    ipcRenderer.send(WINDOW_CHANNELS.quit, options)
  }
}

/**
 * 「打开过的项目」的后端。
 *
 * 单独收成一个命名空间：它既不是窗口能力，也不属于插件，而是宿主的一等业务
 * 能力（欢迎窗口与「欢迎 -> 主窗口」的切换都靠它）。所有判断都在主进程 ——
 * 目录存不存在这类事实只有主进程看得到。
 */
/**
 * host 侧 `project.list` 的延迟绑定。
 *
 * port 到达前为 null —— 此时走旧 IPC，host 未启用或尚未连接都不影响界面。
 * 这是阶段 2 的绞杀者接缝：调用方（projectAPI.list）不认识 host，只认这个函数。
 */
let hostProjectList: (() => Promise<ProjectListItem[]>) | null = null

/** host 侧文件读写的延迟绑定；port 未到 / host 未启用时为 null。 */
let hostReadDir: ((dirPath: string) => Promise<DirReadResult>) | null = null
let hostReadFile: ((filePath: string) => Promise<FileReadResult>) | null = null
let hostWriteFile: ((request: WriteFileRequest) => Promise<FileWriteResult>) | null = null
let hostCreateEntry: ((request: CreateEntryRequest) => Promise<CreateEntryResult>) | null = null
let hostRenameEntry: ((request: RenameEntryRequest) => Promise<RenameEntryResult>) | null = null
let hostDeleteEntry: ((request: DeleteEntryRequest) => Promise<DeleteEntryResult>) | null = null
let hostReadChapters: ((dirPath: string) => Promise<ChapterListResult>) | null = null
let hostReadForeshadowing: ((dirPath: string) => Promise<ForeshadowingListResult>) | null = null
let hostReadGalleries: ((galleryRoot: string) => Promise<GalleryListResult>) | null = null
let hostCreateGallery: ((request: GalleryCreateRequest) => Promise<GalleryCreateResult>) | null =
  null
let hostUpdateGalleryRegistry:
  ((request: GalleryRegistryUpdateRequest) => Promise<GalleryRegistryUpdateResult | null>) | null =
  null
let hostReadOverview: ((overviewRoot: string) => Promise<OverviewListResult>) | null = null
let hostSetOverviewRole:
  ((request: OverviewRoleUpdateRequest) => Promise<OverviewRoleUpdateResult>) | null = null
let hostReadConfig: (() => Promise<ProjectConfig | null>) | null = null
let hostUpdateConfig:
  ((patch: ProjectConfigPatch) => Promise<ProjectConfigUpdateResult | null>) | null = null
let hostGetPlugins: (() => Promise<PluginDescriptor[]>) | null = null
let hostGetDisabledPlugins: (() => Promise<string[]>) | null = null
let hostGetClientBundles: (() => Promise<ClientBundleDescriptor[]>) | null = null

const projectAPI = {
  /** 「打开过的项目」列表，最近打开的在前 */
  list: async (): Promise<ProjectListItem[]> => {
    if (hostProjectList) {
      try {
        const projects = await hostProjectList()
        preloadLogger.info('project.list served by host', { count: projects.length })
        return projects
      } catch (error) {
        preloadLogger.warn('host project.list failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(PROJECT_CHANNELS.list)
  },

  /**
   * 打开列表里的某一条。目录已经不在时返回带原因的结果，不抛异常。
   *
   * 当前有项目、且打开的是另一个项目时，主进程会先弹一次二次确认（换项目要重建
   * 窗口、丢掉未保存的内容）；用户拒了就回 `{ ok: false, reason: 'cancelled' }`。
   */
  open: (dirPath: string, options?: ConfirmOptions): Promise<ProjectOpenResult> =>
    ipcRenderer.invoke(PROJECT_CHANNELS.open, dirPath, options),

  /** 弹系统目录对话框并打开所选目录。用户取消时返回 { ok: false, reason: 'cancelled' } */
  pick: (mode: ProjectPickMode, options?: ConfirmOptions): Promise<ProjectOpenResult> =>
    ipcRenderer.invoke(PROJECT_CHANNELS.pick, mode, options),

  /** 从列表里移除一条记录（磁盘上的目录不动），返回移除后的列表 */
  remove: (dirPath: string): Promise<ProjectListItem[]> =>
    ipcRenderer.invoke(PROJECT_CHANNELS.remove, dirPath),

  /**
   * 关闭当前项目，回退到欢迎窗口。记录留在列表里，下次启动仍然默认打开它。
   *
   * 单向 send：调用之后这个窗口就会被拆掉，等一个永远到不了的应答没有意义
   * （与 window.restart 同理）。确认框由主进程问，这里传 `{ confirm: false }`
   * 表示调用方刚刚已经问过用户了。
   */
  close: (options?: ConfirmOptions): void => {
    ipcRenderer.send(PROJECT_CHANNELS.close, options)
  },

  /**
   * 读项目里的一层目录（文件树）。
   *
   * 只传路径，不传「项目根在哪」：范围由主进程对照当前项目判断。渲染进程能声明的
   * 只有「我想读哪儿」，不能声明「我允许读到哪儿」。
   *
   * 失败不抛异常，返回带原因的结果 —— 目录被删、没权限都是常见状态，
   * 界面要按原因说话，而不是接到一个 rejected promise。
   */
  readDir: async (dirPath: string): Promise<DirReadResult> => {
    if (hostReadDir) {
      try {
        return await hostReadDir(dirPath)
      } catch (error) {
        preloadLogger.warn('host files.readDir failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(PROJECT_FILE_CHANNELS.readDir, dirPath)
  },

  /** 读项目里的一个纯文本 / Markdown 文件。失败同样返回带原因的结果 */
  readFile: async (filePath: string): Promise<FileReadResult> => {
    if (hostReadFile) {
      try {
        return await hostReadFile(filePath)
      } catch (error) {
        preloadLogger.warn('host files.readFile failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(PROJECT_FILE_CHANNELS.readFile, filePath)
  },

  /**
   * 读一个内容目录里的章节列表（含每一章的编号）。
   *
   * 与 readDir 分开：这一步会只读每个文件的**开头**（frontmatter）取章节号，
   * 而渲染进程没有「只读一段」这个能力 —— 那是主进程的活。
   */
  readChapters: async (dirPath: string): Promise<ChapterListResult> => {
    if (hostReadChapters) {
      try {
        return await hostReadChapters(dirPath)
      } catch (error) {
        preloadLogger.warn('host files.readChapters failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(PROJECT_FILE_CHANNELS.readChapters, dirPath)
  },

  /**
   * 读一个内容目录里的伏笔列表（名称 / 起始章节 / 结束章节 / 描述）。
   *
   * 与 readChapters 同一条理由：列表要扫一个目录并逐份取出字段；交给渲染进程就
   * 只有「一次读一个文件」这一条路。读不出字段的 yml 仍然列出来，只是名称回落到文件名。
   */
  readForeshadowing: async (dirPath: string): Promise<ForeshadowingListResult> => {
    if (hostReadForeshadowing) {
      try {
        return await hostReadForeshadowing(dirPath)
      } catch (error) {
        preloadLogger.warn('host files.readForeshadowing failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(PROJECT_FILE_CHANNELS.readForeshadowing, dirPath)
  },

  /**
   * 新建文件 / 文件夹。
   *
   * 只报「右键了谁」+「新名字」，不报目标目录 —— 目标目录由主进程从被右键的
   * 条目推导，渲染进程因此无法指定任意写入位置。已存在时返回
   * `{ ok: false, reason: 'already-exists' }`，**不会覆盖**。
   */
  createEntry: async (request: CreateEntryRequest): Promise<CreateEntryResult> => {
    if (hostCreateEntry) {
      try {
        return await hostCreateEntry(request)
      } catch (error) {
        preloadLogger.warn('host files.createEntry failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(PROJECT_FILE_CHANNELS.createEntry, request)
  },

  /**
   * 把正文写回一个文件（保存）。
   *
   * 只报「写哪个文件」+「写什么」，不报「写到哪儿」—— 保存不是另存为，它覆盖的
   * 正是这个路径当初读出来的那个文件。范围与格式由主进程判断：路径跑出当前项目、
   * 目标已经不在了、是个符号链接、或者格式宿主不解码时都会拒绝并给出原因。
   *
   * 失败不抛异常，返回带原因的结果：磁盘满、文件被别的程序独占都是常见状态，
   * 界面要按原因说话（保存对话框据此留在原地）。
   */
  writeFile: async (request: WriteFileRequest): Promise<FileWriteResult> => {
    if (hostWriteFile) {
      try {
        return await hostWriteFile(request)
      } catch (error) {
        preloadLogger.warn('host files.writeFile failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(PROJECT_FILE_CHANNELS.writeFile, request)
  },

  /**
   * 给一个文件 / 文件夹改名。
   *
   * 只报「被右键了谁」+「新名字」，不报「改到哪儿」—— 目录就是那个条目自己
   * 所在的那一层，由主进程 / host 推导。同名条目已存在时返回
   * `{ ok: false, reason: 'already-exists' }`，**不会覆盖**。
   *
   * host 改名成功之后会顺手改概述映射（大纲 / 写作风格的标记在 `.nide/config.yml`
   * 里）——配置服务已经在 host，这一步不再是 shell 的后续动作。
   */
  renameEntry: async (request: RenameEntryRequest): Promise<RenameEntryResult> => {
    if (hostRenameEntry) {
      try {
        return await hostRenameEntry(request)
      } catch (error) {
        preloadLogger.warn('host files.renameEntry failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(PROJECT_FILE_CHANNELS.renameEntry, request)
  },

  /**
   * 删除一个文件 / 文件夹。目录连同里面的东西一起删，**不可撤销**。
   *
   * 二次确认仍然问在 shell（见 main/confirm.ts）：host 没有窗口，问不出浮层。
   * 所以顺序是「先问 shell -> 再让 host 删」，用户拒了就回 `cancelled`，不会碰盘。
   *
   * 回退：确认本身失败时走旧 IPC（它会自己再问一次）；host 删除失败时也走旧 IPC，
   * 但带 `{ confirm: false }` —— 用户刚刚已经答过一次，不能问第二遍。
   */
  deleteEntry: async (
    request: DeleteEntryRequest,
    options?: ConfirmOptions
  ): Promise<DeleteEntryResult> => {
    if (hostDeleteEntry) {
      let confirmed: boolean
      try {
        confirmed = await ipcRenderer.invoke(PROJECT_FILE_CHANNELS.confirmDelete, request, options)
      } catch (error) {
        preloadLogger.warn('delete confirmation failed, falling back to IPC', { error })
        return ipcRenderer.invoke(PROJECT_FILE_CHANNELS.deleteEntry, request, options)
      }

      if (!confirmed) return { ok: false, reason: 'cancelled' }

      try {
        return await hostDeleteEntry(request)
      } catch (error) {
        preloadLogger.warn('host files.deleteEntry failed, falling back to IPC', { error })
        return ipcRenderer.invoke(PROJECT_FILE_CHANNELS.deleteEntry, request, { confirm: false })
      }
    }

    return ipcRenderer.invoke(PROJECT_FILE_CHANNELS.deleteEntry, request, options)
  },

  /**
   * 读图鉴：内容目录下每个子目录一个图鉴（各自的字段表与条目），外加 `.nide` 里的
   * 注册表（哪个图鉴是角色图鉴）。
   *
   * 传的是图鉴内容目录的绝对路径，而它必须**正是**配置里那一个 —— 判据在 host：
   * 渲染进程只声明「我想读这个图鉴目录」，声明不了「哪个目录算图鉴目录」。
   */
  readGalleries: async (galleryRoot: string): Promise<GalleryListResult> => {
    if (hostReadGalleries) {
      try {
        return await hostReadGalleries(galleryRoot)
      } catch (error) {
        preloadLogger.warn('host gallery.read failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(PROJECT_GALLERY_CHANNELS.readGalleries, galleryRoot)
  },

  /**
   * 新建一个图鉴：一个目录 + 它的 `config.yml`。
   *
   * 落点（`request.targetPath`）同样必须是配置里那个图鉴内容目录，host 会核对；
   * 目录已存在时**不覆盖**，返回 `already-exists`。
   */
  createGallery: async (request: GalleryCreateRequest): Promise<GalleryCreateResult> => {
    if (hostCreateGallery) {
      try {
        return await hostCreateGallery(request)
      } catch (error) {
        preloadLogger.warn('host gallery.create failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(PROJECT_GALLERY_CHANNELS.createGallery, request)
  },

  /**
   * 改图鉴注册表（把某一个图鉴设成角色图鉴）。
   *
   * 名字指向的目录不在时返回 `unknown-gallery`：注册表指向一个不存在的图鉴，章节表单
   * 的出场角色就永远选不出东西，而那在界面上看不出任何原因。
   */
  updateGalleryRegistry: async (
    request: GalleryRegistryUpdateRequest
  ): Promise<GalleryRegistryUpdateResult | null> => {
    if (hostUpdateGalleryRegistry) {
      try {
        return await hostUpdateGalleryRegistry(request)
      } catch (error) {
        preloadLogger.warn('host gallery.updateRegistry failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(PROJECT_GALLERY_CHANNELS.updateRegistry, request)
  },

  /**
   * 读概述：内容目录里平铺的 Markdown。
   *
   * 「哪份是大纲 / 写作风格」不在这份结果里：那是项目配置里的标记，渲染进程手里
   * 已经有 `config.overview`，照着它认即可。
   *
   * 传的是概述内容目录的绝对路径，而它必须**正是**配置里那一个 —— 判据在 host：
   * 渲染进程只声明「我想读这个概述目录」，声明不了「哪个目录算概述目录」。
   */
  readOverview: async (overviewRoot: string): Promise<OverviewListResult> => {
    if (hostReadOverview) {
      try {
        return await hostReadOverview(overviewRoot)
      } catch (error) {
        preloadLogger.warn('host overview.read failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(PROJECT_OVERVIEW_CHANNELS.readOverview, overviewRoot)
  },

  /**
   * 把概述里的某份 Markdown 标记成大纲 / 写作风格。
   *
   * 改的是**项目配置**的概述那一段，不是那份文档本身。文件不在了、或者不是 Markdown
   * 时 host 拒绝并给出原因。
   */
  setOverviewRole: async (
    request: OverviewRoleUpdateRequest
  ): Promise<OverviewRoleUpdateResult> => {
    if (hostSetOverviewRole) {
      try {
        return await hostSetOverviewRole(request)
      } catch (error) {
        preloadLogger.warn('host overview.setRole failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(PROJECT_OVERVIEW_CHANNELS.setRole, request)
  },

  /**
   * 读当前项目的配置（`.nide/config.yml`）。
   *
   * 不传路径：读的就是当前项目，写到哪儿也由 host 决定。`.nide` 被删或配置文件
   * 坏掉时 host 会静默重建默认配置，所以这里不会返回「没有配置」这种状态 ——
   * 只有「当前没有项目」时给 null。
   */
  readConfig: async (): Promise<ProjectConfig | null> => {
    if (hostReadConfig) {
      try {
        return await hostReadConfig()
      } catch (error) {
        preloadLogger.warn('host config.read failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(PROJECT_CONFIG_CHANNELS.read)
  },

  /**
   * 更新当前项目的配置。补丁里只放要改的分区（`{ chapters: { path: 'manuscript' } }`）；
   * 校验不合格时 host **一项都不写**，返回的 config 是磁盘上那份没被改动的配置。
   */
  updateConfig: async (patch: ProjectConfigPatch): Promise<ProjectConfigUpdateResult | null> => {
    if (hostUpdateConfig) {
      try {
        return await hostUpdateConfig(patch)
      } catch (error) {
        preloadLogger.warn('host config.update failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(PROJECT_CONFIG_CHANNELS.update, patch)
  }
}

/**
 * 主题的渲染侧端口。
 *
 * 单独收成一个命名空间：它既不是窗口能力也不是项目能力，而是宿主的界面偏好 ——
 * 和「行为级二次确认」平级。
 *
 * 载荷是**主进程算好的结论**（可选哪些主题、现在用哪个、那个主题的每个令牌是什么
 * 值），不是让渲染进程自己解析主题文件：读盘、瀑布补齐、令牌合法性都在主进程做完，
 * 渲染进程只负责把令牌写成 CSS 变量。
 */
const appearanceAPI = {
  /**
   * 订阅主题变化。返回的 Disposable 用来退订。
   *
   * 三种来源共用这一条通道：用户在设置里提交了、系统外观变了（跟随系统时）、
   * 别的窗口改了。渲染进程不需要区分来源。
   *
   * **注意载荷形状**：主进程是经 `host:event` 那条既有总线广播的（同
   * `pushEventToRenderer`），而那条总线的第一个参数是**频道名**，真正的载荷跟在
   * 它后面。所以这里要按 `(event, channel, payload)` 收，并且自己过滤频道名 ——
   * 不能按 `(event, payload)` 直接收，也不能 `ipcRenderer.on(APPEARANCE_CHANNEL)`：
   * 那条通道名只是总线里的一个字符串，从来不是独立的事件名。
   * 频道名要和 main/appearance 的 APPEARANCE_CHANNEL 一致。
   */
  onChanged: (handler: (payload: ThemePayload) => void): Disposable => {
    const wrapped = (_e: unknown, channel: string, ...args: unknown[]): void => {
      if (channel !== APPEARANCE_CHANNEL) return
      const payload = args[0] as ThemePayload | undefined
      if (payload) handler(payload)
    }
    ipcRenderer.on(HOST_CHANNELS.event, wrapped)
    return {
      dispose: () => ipcRenderer.off(HOST_CHANNELS.event, wrapped)
    }
  },

  /**
   * 拉一次当前主题的完整载荷（可选哪些、现在用哪个、那个是深是浅）。
   *
   * 首帧的配色走启动参数，不依赖这里；这一步补的是**可选主题列表**。
   */
  get: (): Promise<ThemePayload> => ipcRenderer.invoke(HOST_CHANNELS.getTheme),

  /**
   * 提交一套主题。主进程负责校验、落盘与广播；不重建窗口、不确认、不丢未保存内容。
   *
   * 返回 false 表示这个主题不存在（id 拼错），什么都没改。
   */
  setTheme: (theme: ThemeId): Promise<boolean> =>
    ipcRenderer.invoke(HOST_CHANNELS.setTheme, { theme })
}

/**
 * 行为级二次确认的渲染侧端口。
 *
 * 单独收成一个命名空间，因为它的两端都不是「业务」：主进程只发「有人要你确认一件
 * 事」，渲染进程只回「确认 / 取消」。它属于宿主本身，既不是窗口能力也不是项目能力，
 * 所以和 window / projects 平级。
 */
const confirmAPI = {
  /**
   * 订阅主进程发来的确认请求。
   *
   * 朴素的一问一答：收到请求 -> 画浮层 -> 用 `respond` 把同一个 id 送回去。主进程
   * 可能同时问着不止一件事，所以消费方要能应付排队（见 renderer 的 ConfirmHost）。
   */
  onRequest: (handler: (request: ConfirmRequest) => void): Disposable => {
    const wrapped = (_e: unknown, request: ConfirmRequest): void => handler(request)
    ipcRenderer.on(CONFIRM_CHANNELS.request, wrapped)
    return {
      dispose: () => ipcRenderer.off(CONFIRM_CHANNELS.request, wrapped)
    }
  },

  /**
   * 回答一次询问。
   *
   * 只有**被问的那个窗口**的回答会被采纳（主进程按发起方核对），所以渲染进程拿它
   * 伪造不了别的窗口的答案。id 对不上、或者这一问已经结束的回答，主进程按过期丢掉。
   */
  respond: (id: string, confirmed: boolean): void => {
    ipcRenderer.send(CONFIRM_CHANNELS.respond, { id, confirmed })
  }
}

/**
 * AI 供应商的渲染侧端口。
 *
 * - `list/save/remove/test` 只碰非密配置与“是否已配置”；
 * - `open/abort/onEvent` 是 Agent 用的透明转发：分片按 requestId 回到**发起窗口**，
 *   不广播。key 永远不出现在任何返回值里。
 */
const aiProviderAPI = {
  list: (): Promise<ProviderSummary[]> => ipcRenderer.invoke(AI_PROVIDER_CHANNELS.list),

  save: (request: SaveProviderRequest): Promise<SaveProviderResult> =>
    ipcRenderer.invoke(AI_PROVIDER_CHANNELS.save, request),

  remove: (providerId: string): Promise<RemoveProviderResult> =>
    ipcRenderer.invoke(AI_PROVIDER_CHANNELS.remove, providerId),

  test: (request: TestProviderRequest): Promise<TestProviderResult> =>
    ipcRenderer.invoke(AI_PROVIDER_CHANNELS.test, request),

  open: (request: ChatOpenRequest): Promise<ChatOpenResult> =>
    ipcRenderer.invoke(AI_PROVIDER_CHANNELS.open, request),

  abort: (requestId: string): Promise<void> =>
    ipcRenderer.invoke(AI_PROVIDER_CHANNELS.abort, requestId),

  onEvent: (handler: (event: ChatStreamEvent) => void): Disposable => {
    const wrapped = (_event: unknown, payload: ChatStreamEvent): void => handler(payload)
    ipcRenderer.on(AI_PROVIDER_CHANNELS.event, wrapped)
    return { dispose: () => ipcRenderer.off(AI_PROVIDER_CHANNELS.event, wrapped) }
  }
}

const api = {
  /**
   * 获取所有插件注册的 UI 视图元信息。
   * 返回 [{ id, title, location, pluginId, dir, entry }] —— 纯数据。
   */
  getPluginViews: () => ipcRenderer.invoke(HOST_CHANNELS.getPluginViews),
  /** 全局设置里的插件子设置页（已按当前语言解析标题，被禁用插件的不返回） */
  getPluginSettings: () => ipcRenderer.invoke(HOST_CHANNELS.getPluginSettings),
  /** 获取当前语言的词条表、可用语言列表和漏翻体检结果。
   *
   * 渲染进程没有 fs，也不该知道语言包文件在哪 —— 它只消费主进程算好的结果。
   */
  getI18n: (): Promise<I18nPayload> => ipcRenderer.invoke(HOST_CHANNELS.getI18n),

  /** 「设置 -> 插件」用的插件清单。和 getPluginViews 是两件事：那个是视图，这个是插件本体 */
  getPlugins: async (): Promise<PluginDescriptor[]> => {
    if (hostGetPlugins) {
      try {
        return await hostGetPlugins()
      } catch (error) {
        preloadLogger.warn('host plugins.list failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(HOST_CHANNELS.getPlugins)
  },

  /** 已启用插件的浏览器半 bundle 清单（开发期是绝对路径，生产环境换 app 协议） */
  getClientBundles: async (): Promise<ClientBundleDescriptor[]> => {
    if (hostGetClientBundles) {
      try {
        return await hostGetClientBundles()
      } catch (error) {
        preloadLogger.warn('host plugins.clientBundles failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(HOST_CHANNELS.getClientBundles)
  },

  /** 核心包清单（只读）：宿主服务 + 客户端平台包 */
  getCorePackages: async (): Promise<CorePackage[]> => {
    try {
      return await ipcRenderer.invoke(HOST_CHANNELS.getCorePackages)
    } catch (error) {
      preloadLogger.warn('host plugins.core failed', { error })
      return []
    }
  },

  /**
   * 启用 / 禁用插件。禁用后它的视图会从工具区消失；状态由宿主落盘，重启后仍然有效。
   *
   * 返回 false 表示用户在「启用第三方插件」的信任确认里取消了 —— 状态没有变。
   * `options: { confirm: false }` 供已经问过用户的调用方跳过那一问。
   */
  setPluginEnabled: (
    pluginId: string,
    enabled: boolean,
    options?: ConfirmOptions
  ): Promise<boolean> =>
    ipcRenderer.invoke(HOST_CHANNELS.setPluginEnabled, pluginId, enabled, options),

  /**
   * 从本地文件夹安装插件：shell 弹目录对话框，host 负责复制 / 校验 / 重扫。
   * 装进来默认禁用；启用来的时候会过一道信任确认。
   */
  installPlugin: (): Promise<PluginInstallResult> =>
    ipcRenderer.invoke(HOST_CHANNELS.installPlugin),

  /** 卸载一个第三方插件；内置插件返回 `builtin`，用户取消返回 `cancelled` */
  removePlugin: (pluginId: string): Promise<PluginRemoveResult> =>
    ipcRenderer.invoke(HOST_CHANNELS.removePlugin, pluginId),

  /** 当前被禁用的插件 id（宿主持久化过的那份）。渲染进程启动时取一次，用来过滤视图列表 */
  getDisabledPlugins: async (): Promise<string[]> => {
    if (hostGetDisabledPlugins) {
      try {
        return await hostGetDisabledPlugins()
      } catch (error) {
        preloadLogger.warn('host plugins.disabled failed, falling back to IPC', { error })
      }
    }
    return ipcRenderer.invoke(HOST_CHANNELS.getDisabledPlugins)
  },

  /**
   * 订阅「插件启用状态变了」。
   *
   * 需要它的原因是窗口模型：设置窗口和主窗口是两个渲染进程、两份 store。
   * 在设置窗口里禁用插件，主窗口那边的视图列表不会自己更新 —— 必须有人推它一把。
   *
   * 注意载荷形状：主进程是经 `HOST_CHANNELS.event` 这条既有总线广播的，而那条
   * 总线的第一个参数是**频道名**，真正的参数跟在它后面。所以这里的 wrapped 要按
   * `(event, channel, ...args)` 收，不能直接按 `(event, pluginId, enabled)` 收。
   * 频道名取自 HOST_EVENT_CHANNELS，与主进程发送方共用同一个常量。
   */
  onPluginEnabledChanged: (handler: (pluginId: string, enabled: boolean) => void): Disposable => {
    const wrapped = (_e: unknown, channel: string, ...args: unknown[]): void => {
      if (channel !== HOST_EVENT_CHANNELS.pluginEnabledChanged) return
      handler(String(args[0]), Boolean(args[1]))
    }
    ipcRenderer.on(HOST_CHANNELS.event, wrapped)
    return {
      dispose: () => ipcRenderer.off(HOST_CHANNELS.event, wrapped)
    }
  },

  /** 请求切换语言。真正生效需要重建窗口，由主进程自己处理 */
  setLocale: (locale: LocaleId): Promise<void> =>
    ipcRenderer.invoke(HOST_CHANNELS.setLocale, locale),

  /**
   * 事件总线：渲染进程向宿主（或插件后端）发送事件
   */
  emitEvent: (channel: string, ...args: unknown[]) => {
    ipcRenderer.send(HOST_CHANNELS.eventEmit, channel, ...args)
  },

  /**
   * 事件总线：渲染进程监听事件
   */
  onEvent: (channel: string, handler: (...args: unknown[]) => void): Disposable => {
    if (!listeners.has(channel)) {
      listeners.set(channel, new Set())
    }
    listeners.get(channel)!.add(handler)
    return {
      dispose: () => {
        listeners.get(channel)?.delete(handler)
      }
    }
  },

  /** 编辑器内容变化通知主进程 */
  notifyEditorChange: (filePath: string, content: string) => {
    ipcRenderer.send(HOST_CHANNELS.editorChange, filePath, content)
  },

  /** 宿主请求展示 Diff（Monaco Diff 组件消费） */
  onShowDiff: (handler: (original: string, modified: string) => void): Disposable => {
    const wrapped = (_e: unknown, original: string, modified: string): void =>
      handler(original, modified)
    ipcRenderer.on(HOST_CHANNELS.showDiff, wrapped)
    return {
      dispose: () => ipcRenderer.off(HOST_CHANNELS.showDiff, wrapped)
    }
  },

  /** 宿主刷新 Monaco 编辑器内容 */
  onFileChanged: (handler: (filePath: string, content: string) => void): Disposable => {
    const wrapped = (_e: unknown, filePath: string, content: string): void =>
      handler(filePath, content)
    ipcRenderer.on(HOST_CHANNELS.fileChanged, wrapped)
    return {
      dispose: () => ipcRenderer.off(HOST_CHANNELS.fileChanged, wrapped)
    }
  },

  /** 弹出按钮条的右键菜单，返回「显示标题」的最新勾选状态 */
  showStripeMenu: (showTitles: boolean): Promise<boolean> =>
    ipcRenderer.invoke(HOST_CHANNELS.showStripeMenu, showTitles),

  /**
   * 渲染进程的日志出口。
   *
   * 暴露的是**函数**而不是通道名，所以渲染进程只能按级别打印，不能拿它往
   * 任意 channel 发任意载荷 —— 那等于给渲染进程开了一条伪造 IPC 的路。
   */
  log: {
    error: (text: string, fields?: Record<string, unknown>): void =>
      sendLog({ date: new Date(), level: 'error', scope: 'renderer', text, fields }),
    warn: (text: string, fields?: Record<string, unknown>): void =>
      sendLog({ date: new Date(), level: 'warn', scope: 'renderer', text, fields }),
    info: (text: string, fields?: Record<string, unknown>): void =>
      sendLog({ date: new Date(), level: 'info', scope: 'renderer', text, fields }),
    debug: (text: string, fields?: Record<string, unknown>): void =>
      sendLog({ date: new Date(), level: 'debug', scope: 'renderer', text, fields })
  },

  /**
   * 窗口本体：最小化 / 最大化 / 关闭 / 打开别的窗口。
   *
   * 单独收成一个命名空间，和「宿主业务能力」分开 —— 前者每个窗口都有，
   * 后者是主窗口才关心的东西。
   */
  window: windowAPI,

  /** 项目：打开过的文件夹、当前项目、目录对话框（见 projectAPI 的说明） */
  projects: projectAPI,

  /** 主题偏好（见 appearanceAPI 的说明） */
  appearance: appearanceAPI,

  /** AI 供应商：设置页读写 + Agent 的透明转发（见 aiProviderAPI） */
  aiProvider: aiProviderAPI,

  /**
   * 行为级二次确认在渲染进程这一侧的端口。
   *
   * 只有**一个**消费者：`renderer/ui/ConfirmHost`（每一种窗口都挂着它）。它把主进程
   * 送来的问题画成浮层，再把用户的回答送回去。别的组件不需要碰这两个函数 ——
   * 要确认的是**动作**（主进程那边管），不是某个按钮。
   */
  confirm: confirmAPI

  /** 插件管理（占位） */
}

/**
 * 渲染进程侧的日志出口。
 *
 * 两件事：
 *
 * 1. 暴露 `window.hostAPI.log`，渲染进程唯一的日志出口。
 * 2. 补上 `window.__electronLog` —— electron-log 的渲染进程实现会在这里找
 *    出口。宿主不用它（`hostAPI.log` 已经够），但插件作者可能直接
 *    `import log from 'electron-log/renderer'`，留一个能用的出口比让那条路径
 *    静默失败好。主进程侧对应的 `log.initialize({ preload: false })` 只装了
 *    IPC 回流这一半，所以两边不会重复接管。
 */
function exposeLogBridge(): void {
  const bridge = {
    sendToMain: (payload: unknown): void => ipcRenderer.send(WINDOW_CHANNELS.log, payload),
    error: (...data: unknown[]): void => sendRaw('error', data),
    warn: (...data: unknown[]): void => sendRaw('warn', data),
    info: (...data: unknown[]): void => sendRaw('info', data),
    verbose: (...data: unknown[]): void => sendRaw('debug', data),
    debug: (...data: unknown[]): void => sendRaw('debug', data),
    silly: (...data: unknown[]): void => sendRaw('debug', data),
    log: (...data: unknown[]): void => sendRaw('info', data)
  }

  window.__electronLog = bridge as unknown as typeof window.__electronLog
}

/** electron-log 的数据是可变参数列表，这里折叠成单条文本 + 结构化字段 */
function sendRaw(level: LogMessage['level'], data: unknown[]): void {
  const [first, ...rest] = data
  sendLog({
    date: new Date(),
    level,
    scope: 'renderer',
    text: typeof first === 'string' ? first : String(first),
    ...(rest.length > 0 ? { fields: { data: rest } } : {})
  })
}

/**
 * renderer ↔ host 直连 port（MVP）。
 *
 * 主进程在 `did-finish-load` 后通过 `webContents.postMessage(HOST_PORT_CHANNEL)`
 * 送来一个 MessagePort；renderer 直接与 host 通信，不经过 shell 转发。
 *
 * 协议：`{ type: 'rpc', id, namespace, method, args }`，
 * host 回 `{ type: 'rpc-result', id, ok, result | error }`。
 * TODO: 事件推送、取消、超时策略、schema 校验。
 */
let hostPort: MessagePort | null = null
let hostRequestSeq = 0
const hostPending = new Map<
  string,
  {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }
>()

ipcRenderer.on(HOST_PORT_CHANNEL, (event) => {
  const port = event.ports[0]
  if (!port) return

  hostPort = port
  hostProjectList = () => hostInvoke('project', 'list') as Promise<ProjectListItem[]>
  hostReadDir = (dirPath) => hostInvoke('files', 'readDir', [dirPath]) as Promise<DirReadResult>
  hostReadFile = (filePath) =>
    hostInvoke('files', 'readFile', [filePath]) as Promise<FileReadResult>
  hostWriteFile = (request) =>
    hostInvoke('files', 'writeFile', [request]) as Promise<FileWriteResult>
  hostCreateEntry = (request) =>
    hostInvoke('files', 'createEntry', [request]) as Promise<CreateEntryResult>
  hostRenameEntry = (request) =>
    hostInvoke('files', 'renameEntry', [request]) as Promise<RenameEntryResult>
  // 删一棵大树可能比默认的 5s 久：给删除单独放宽，别在它删到一半时切回旧路径
  hostDeleteEntry = (request) =>
    hostInvoke('files', 'deleteEntry', [request], 30_000) as Promise<DeleteEntryResult>
  hostReadChapters = (dirPath) =>
    hostInvoke('files', 'readChapters', [dirPath]) as Promise<ChapterListResult>
  hostReadForeshadowing = (dirPath) =>
    hostInvoke('files', 'readForeshadowing', [dirPath]) as Promise<ForeshadowingListResult>
  hostReadGalleries = (galleryRoot) =>
    hostInvoke('gallery', 'read', [galleryRoot]) as Promise<GalleryListResult>
  hostCreateGallery = (request) =>
    hostInvoke('gallery', 'create', [request]) as Promise<GalleryCreateResult>
  hostUpdateGalleryRegistry = (request) =>
    hostInvoke('gallery', 'updateRegistry', [
      request
    ]) as Promise<GalleryRegistryUpdateResult | null>
  hostReadOverview = (overviewRoot) =>
    hostInvoke('overview', 'read', [overviewRoot]) as Promise<OverviewListResult>
  hostSetOverviewRole = (request) =>
    hostInvoke('overview', 'setRole', [request]) as Promise<OverviewRoleUpdateResult>
  hostReadConfig = () => hostInvoke('config', 'read', []) as Promise<ProjectConfig | null>
  hostUpdateConfig = (patch) =>
    hostInvoke('config', 'update', [patch]) as Promise<ProjectConfigUpdateResult | null>
  hostGetPlugins = () => hostInvoke('plugins', 'list', []) as Promise<PluginDescriptor[]>
  hostGetDisabledPlugins = () => hostInvoke('plugins', 'disabled', []) as Promise<string[]>
  hostGetClientBundles = () =>
    hostInvoke('plugins', 'clientBundles', []) as Promise<ClientBundleDescriptor[]>

  // 窗口知道自己绑定的是哪个项目；换项目后 host 需要跟着切。
  const bootProject = readBootProjectPath()
  if (bootProject) {
    void hostInvoke('project', 'setCurrent', [bootProject]).catch((error: unknown) => {
      preloadLogger.warn('failed to sync the host current project', { error })
    })
  }

  port.onmessage = (message) => {
    const data = message.data
    if (!isRpcResponse(data)) return

    const pending = hostPending.get(data.id)
    if (!pending) return

    clearTimeout(pending.timer)
    hostPending.delete(data.id)

    if (data.ok) {
      pending.resolve(data.result)
      return
    }

    const error = new Error(data.error.message) as Error & { code?: string }
    error.code = data.error.code
    pending.reject(error)
  }
  port.start()
  preloadLogger.info('Host port attached')
})

function hostInvoke(
  namespace: string,
  method: string,
  args: unknown[] = [],
  timeoutMs = 5000
): Promise<unknown> {
  const port = hostPort
  if (!port) return Promise.reject(new Error('host port is not attached'))

  const id = `renderer-${++hostRequestSeq}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      hostPending.delete(id)
      reject(new Error(`${namespace}.${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    hostPending.set(id, { resolve, reject, timer })
    port.postMessage({ type: 'rpc', id, namespace, method, args })
  })
}

const nideHost = {
  available: (): boolean => hostPort !== null,
  invoke: <T = unknown>(namespace: string, method: string, ...args: unknown[]): Promise<T> =>
    hostInvoke(namespace, method, args) as Promise<T>,
  ping: (): Promise<unknown> => hostInvoke('host', 'ping', [])
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('hostAPI', api)
    contextBridge.exposeInMainWorld('nideHost', nideHost)
    contextBridge.exposeInMainWorld('__NIDE_BOOT__', {
      locale: readBootLocale(),
      appearance: readBootAppearance(),
      themePalette: readBootPalette(),
      windowType: readBootWindowType(),
      logLevel,
      projectPath: readBootProjectPath()
    })
    // 必须在隔离世界里挂：非隔离时下面那段自己赋值即可
    exposeLogBridge()
  } catch (error) {
    // 走日志出口而不是裸 console：桥接失败恰恰是最需要留下痕迹的情形，
    // 而这个出口本身不依赖 contextBridge（它就是一条 ipcRenderer.send 的封装）
    preloadLogger.error('Failed to expose the preload bridge', { error })
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.hostAPI = api
  // @ts-ignore (define in dts)
  window.nideHost = nideHost
  // @ts-ignore (define in dts)
  window.__NIDE_BOOT__ = {
    locale: readBootLocale(),
    appearance: readBootAppearance(),
    themePalette: readBootPalette(),
    windowType: readBootWindowType(),
    logLevel,
    projectPath: readBootProjectPath()
  }
  exposeLogBridge()
}

preloadLogger.info('Preload bridge exposed', {
  level: logLevel,
  contextIsolated: process.contextIsolated
})
