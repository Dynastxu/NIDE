/**
 * 窗口契约：宿主所有窗口共用的一份定义。
 *
 * 这一层被主进程、preload、渲染进程三方共用，所以**不能** import electron / DOM。
 * 放 shared 的理由和 LOCALE_ARG_PREFIX 一样：它是一条**跨进程契约** ——
 * 主进程负责写，preload 负责读，渲染进程按它决定挂载哪个界面。
 */

import { projectNameFromPath } from '../project'
import type { HostMessageKey, Translator } from '../i18n'

/**
 * 窗口种类。
 *
 * 每多一种窗口，就要在三个地方同时登记。漏掉任何一处都是编译期可见的：
 * - `WINDOW_SPECS`（src/main/window.ts）：默认尺寸与最小尺寸
 * - `ROOTS`（src/renderer/src/main.tsx）：挂载哪个根组件
 * - 主进程里对应的 create* 入口
 *
 * `main` 与 `welcome` 是**互斥的两个根窗口**：有可用的项目进主窗口，否则进欢迎
 * 窗口（见 main/window.ts 的 openStartupWindow）。`settings` 是挂在根窗口下的
 * 附属窗口，任何时候都能开。
 */
export const WINDOW_TYPES = ['main', 'welcome', 'settings'] as const

export type WindowType = (typeof WINDOW_TYPES)[number]

/**
 * 每种窗口的标题词条。
 *
 * 放在 shared 而不是各自窗口里：主进程要用它设 BrowserWindow 的 title，渲染进程
 * 要用它设 document.title 与自绘标题栏，三处算出来的必须是同一句话。
 */
export const WINDOW_TITLE_KEYS: Record<WindowType, HostMessageKey> = {
  main: 'host.app.title',
  welcome: 'host.welcome.title',
  settings: 'host.settings.title'
}

/**
 * 自绘标题栏上的标题 —— **只有窗口自己的名字**，不带项目名。
 *
 * 主窗口的项目名由标题栏里的项目下拉显示（见 renderer 的 ProjectSelector）：
 * 项目名放在标题里只能在切换项目时整条重建窗口才改得动，而它本来就该是一个
 * 可交互的选择器，不是一段文字。
 */
export function windowTitle(t: Translator, type: WindowType): string {
  return t(WINDOW_TITLE_KEYS[type])
}

/**
 * 操作系统那一层的标题（任务栏 / Alt-Tab / 辅助功能）：主窗口带上项目名。
 *
 * 与自绘标题栏**刻意不同**：那里项目名由下拉显示，而任务栏 / Alt-Tab 上没有下拉，
 * 只有一行字符串可看 —— 同时开着几个项目窗口时，那一行是唯一的区分手段。
 */
export function systemWindowTitle(
  t: Translator,
  type: WindowType,
  projectPath: string | null
): string {
  const base = windowTitle(t, type)
  if (type !== 'main' || !projectPath) return base

  const name = projectNameFromPath(projectPath)
  return name ? `${base} - ${name}` : base
}

/** 启动参数前缀：主进程建窗时把窗口种类喂进渲染进程的 `process.argv` */
export const WINDOW_ARG_PREFIX = '--nide-window='

/**
 * 启动参数前缀：主进程把**日志级别**喂进渲染进程。
 *
 * 走启动参数而不是 IPC，理由和 locale 一样 —— 渲染进程要据此决定「是否接管
 * console」以及每条日志发不发，这件事发生在首个模块求值之前，异步取来不及。
 * 级别本身由主进程统一解析（见 main/logger），渲染进程只读结论，避免两端
 * 各解析一遍环境变量后出现「文件里有 debug、控制台里没有」这类不一致。
 */
export const LOG_LEVEL_ARG_PREFIX = '--nide-log-level='

export function isWindowType(value: string): value is WindowType {
  return (WINDOW_TYPES as readonly string[]).includes(value)
}

/** 渲染进程里的窗口控制动作 */
export type WindowAction = 'minimize' | 'toggleMaximize' | 'close' | 'showSystemMenu'

/**
 * 窗口状态快照。
 *
 * `focused` 也在里面：自绘的关闭按钮要在窗口失焦时变灰，这是自定义标题栏
 * 必须自己补上的一条原生行为，原生标题栏由系统负责。
 */
export interface WindowState {
  maximized: boolean
  focused: boolean
}

/**
 * IPC 通道名。
 *
 * 集中在这里而不是散在 preload 与主进程两处写字面量：拼错通道名不会有任何
 * 编译错误，只会在运行时静默失效（invoke 永远不 resolve、send 石沉大海）。
 */
export const WINDOW_CHANNELS = {
  /** 异步取状态（invoke） */
  state: 'host:window-state',
  /** 同步取状态（sendSync）。只给启动首帧用，见 window.ipc.ts 的说明 */
  stateSync: 'host:window-state:sync',
  stateChanged: 'host:window-state-changed',
  action: 'host:window-action',
  /** 打开某个窗口，参数是 WindowType */
  open: 'host:open-window',
  /**
   * 重建根窗口（界面上的「立即重启」）。
   *
   * 和切语言走同一条实现，但**不是**同一个通道：那条通道会先弹一个本地化的
   * 确认框。设置界面的重启已经问过用户了，再问一遍是重复确认。
   */
  restart: 'host:restart-app',
  /**
   * 退出应用（标题栏「文件 -> 退出」）。
   *
   * 独立于窗口的「关闭」：关闭只关掉这个窗口（主窗口关掉之后应用可能还在，
   * 比如设置窗口还开着，或者 macOS 上进程不退出），而退出是结束整个应用。
   */
  quit: 'host:quit-app',
  /**
   * 渲染进程 / 预加载 -> 主进程的日志转发。
   *
   * 单向 send 而不是 invoke：日志不该有回执，也不该让调用方 await —— 一条
   * 发不出去的日志不值得让任何业务流程卡住。
   */
  log: 'host:log'
} as const
