import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  DEFAULT_LOG_LEVEL,
  createLogger,
  normalizeFields,
  parseLogLevel,
  type LogMessage,
  type Logger
} from '@shared/logger'
import { DEFAULT_LOCALE, LOCALE_ARG_PREFIX } from '@shared/i18n'
import { PROJECT_ARG_PREFIX, PROJECT_CHANNELS } from '@shared/project'
import {
  LOG_LEVEL_ARG_PREFIX,
  WINDOW_ARG_PREFIX,
  WINDOW_CHANNELS,
  isWindowType,
  type WindowAction,
  type WindowState,
  type WindowType
} from '@shared/window'
import type { I18nPayload, LocaleId } from '@shared/i18n'
import type { ProjectListItem, ProjectOpenResult, ProjectPickMode } from '@shared/project'
import type { Disposable, PluginDescriptor } from '@shared/plugin-api'

// ========== 通用事件总线（渲染进程侧） ==========
const listeners = new Map<string, Set<(...args: unknown[]) => void>>()

ipcRenderer.on('host:event', (_event, channel: string, ...args: unknown[]) => {
  listeners.get(channel)?.forEach((handler) => handler(...args))
})

/**
 * 启动语言：从主进程建窗时喂进来的启动参数里**同步**读出来。
 *
 * 只给 Monaco 用（见 renderer 的 monaco-env.ts）—— 它必须在 monaco 模块被求值
 * 之前拿到语言，而那条路径上没有 await 的机会。完整的词条表仍然走异步的
 * host:get-i18n，两者不冲突：这份只有一个字符串。
 */
function readBootLocale(): LocaleId {
  const arg = process.argv.find((item) => item.startsWith(LOCALE_ARG_PREFIX))
  return arg ? arg.slice(LOCALE_ARG_PREFIX.length) : DEFAULT_LOCALE
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
   */
  restart: (): void => {
    ipcRenderer.send(WINDOW_CHANNELS.restart)
  },

  /**
   * 退出应用（标题栏「文件 -> 退出」）。
   *
   * 与 `action('close')` 不同：那个只关掉当前这个窗口，这个结束整个应用。同样用
   * 单向 send —— 应用马上就没了，回执没有任何接收方。
   */
  quit: (): void => {
    ipcRenderer.send(WINDOW_CHANNELS.quit)
  }
}

/**
 * 「打开过的项目」的后端。
 *
 * 单独收成一个命名空间：它既不是窗口能力，也不属于插件，而是宿主的一等业务
 * 能力（欢迎窗口与「欢迎 -> 主窗口」的切换都靠它）。所有判断都在主进程 ——
 * 目录存不存在这类事实只有主进程看得到。
 */
const projectAPI = {
  /** 「打开过的项目」列表，最近打开的在前 */
  list: (): Promise<ProjectListItem[]> => ipcRenderer.invoke(PROJECT_CHANNELS.list),

  /** 打开列表里的某一条。目录已经不在时返回带原因的结果，不抛异常 */
  open: (dirPath: string): Promise<ProjectOpenResult> =>
    ipcRenderer.invoke(PROJECT_CHANNELS.open, dirPath),

  /** 弹系统目录对话框并打开所选目录。用户取消时返回 { ok: false, reason: 'cancelled' } */
  pick: (mode: ProjectPickMode): Promise<ProjectOpenResult> =>
    ipcRenderer.invoke(PROJECT_CHANNELS.pick, mode),

  /** 从列表里移除一条记录（磁盘上的目录不动），返回移除后的列表 */
  remove: (dirPath: string): Promise<ProjectListItem[]> =>
    ipcRenderer.invoke(PROJECT_CHANNELS.remove, dirPath),

  /**
   * 关闭当前项目，回退到欢迎窗口。记录留在列表里，下次启动仍然默认打开它。
   *
   * 单向 send：调用之后这个窗口就会被拆掉，等一个永远到不了的应答没有意义
   * （与 window.restart 同理）。
   */
  close: (): void => {
    ipcRenderer.send(PROJECT_CHANNELS.close)
  }
}

const api = {
  /**
   * 获取所有插件注册的 UI 视图元信息。
   * 返回 [{ id, title, location, pluginId, dir, entry }] —— 纯数据。
   */
  getPluginViews: () => ipcRenderer.invoke('host:get-plugin-views'),

  /** 获取当前语言的词条表、可用语言列表和漏翻体检结果。
   *
   * 渲染进程没有 fs，也不该知道语言包文件在哪 —— 它只消费主进程算好的结果。
   */
  getI18n: (): Promise<I18nPayload> => ipcRenderer.invoke('host:get-i18n'),

  /** 「设置 -> 插件」用的插件清单。和 getPluginViews 是两件事：那个是视图，这个是插件本体 */
  getPlugins: (): Promise<PluginDescriptor[]> => ipcRenderer.invoke('host:get-plugins'),

  /** 启用 / 禁用插件。禁用后它的视图会从工具区消失；宿主侧的状态不落盘 */
  setPluginEnabled: (pluginId: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('host:set-plugin-enabled', pluginId, enabled),

  /** 当前被禁用的插件 id。渲染进程启动时取一次，用来过滤视图列表 */
  getDisabledPlugins: (): Promise<string[]> => ipcRenderer.invoke('host:get-disabled-plugins'),

  /**
   * 订阅「插件启用状态变了」。
   *
   * 需要它的原因是窗口模型：设置窗口和主窗口是两个渲染进程、两份 store。
   * 在设置窗口里禁用插件，主窗口那边的视图列表不会自己更新 —— 必须有人推它一把。
   *
   * 注意载荷形状：主进程是经 `host:event` 这条既有总线广播的，而那条总线的
   * 第一个参数是**频道名**，真正的参数跟在它后面。所以这里的 wrapped 要按
   * `(event, channel, ...args)` 收，不能直接按 `(event, pluginId, enabled)` 收。
   * 频道名要和主进程 host.ipc.ts 的 PLUGIN_STATE_CHANGED_EVENT 一致。
   */
  onPluginEnabledChanged: (handler: (pluginId: string, enabled: boolean) => void): Disposable => {
    const wrapped = (_e: unknown, channel: string, ...args: unknown[]): void => {
      if (channel !== 'plugin:enabled-changed') return
      handler(String(args[0]), Boolean(args[1]))
    }
    ipcRenderer.on('host:event', wrapped)
    return {
      dispose: () => ipcRenderer.off('host:event', wrapped)
    }
  },

  /** 请求切换语言。真正生效需要重建窗口，由主进程自己处理 */
  setLocale: (locale: LocaleId): Promise<void> => ipcRenderer.invoke('host:set-locale', locale),

  /**
   * 事件总线：渲染进程向宿主（或插件后端）发送事件
   */
  emitEvent: (channel: string, ...args: unknown[]) => {
    ipcRenderer.send('host:event-emit', channel, ...args)
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
    ipcRenderer.send('host:editor-change', filePath, content)
  },

  /** 宿主请求展示 Diff（Monaco Diff 组件消费） */
  onShowDiff: (handler: (original: string, modified: string) => void): Disposable => {
    const wrapped = (_e: unknown, original: string, modified: string): void =>
      handler(original, modified)
    ipcRenderer.on('host:show-diff', wrapped)
    return {
      dispose: () => ipcRenderer.off('host:show-diff', wrapped)
    }
  },

  /** 宿主刷新 Monaco 编辑器内容 */
  onFileChanged: (handler: (filePath: string, content: string) => void): Disposable => {
    const wrapped = (_e: unknown, filePath: string, content: string): void =>
      handler(filePath, content)
    ipcRenderer.on('host:file-changed', wrapped)
    return {
      dispose: () => ipcRenderer.off('host:file-changed', wrapped)
    }
  },

  /** 弹出按钮条的右键菜单，返回「显示标题」的最新勾选状态 */
  showStripeMenu: (showTitles: boolean): Promise<boolean> =>
    ipcRenderer.invoke('host:show-stripe-menu', showTitles),

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

  /** 插件管理（占位） */
  reloadPlugin: (pluginId: string) => ipcRenderer.invoke('host:reload-plugin', pluginId)
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

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('hostAPI', api)
    contextBridge.exposeInMainWorld('__NIDE_BOOT__', {
      locale: readBootLocale(),
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
  window.__NIDE_BOOT__ = {
    locale: readBootLocale(),
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
