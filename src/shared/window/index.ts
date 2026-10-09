/**
 * 窗口契约：宿主所有窗口共用的一份定义。
 *
 * 这一层被主进程、preload、渲染进程三方共用，所以**不能** import electron / DOM。
 * 放 shared 的理由和 LOCALE_ARG_PREFIX 一样：它是一条**跨进程契约** ——
 * 主进程负责写，preload 负责读，渲染进程按它决定挂载哪个界面。
 */

/**
 * 窗口种类。
 *
 * 每多一种窗口，就要在三个地方同时登记。漏掉任何一处都是编译期可见的：
 * - `WINDOW_SPECS`（src/renderer/src/window/registry.ts）：标题文案 + 默认尺寸
 * - `WINDOW_ENTRIES`（src/renderer/src/main.tsx）：挂载哪个根组件
 * - 主进程里对应的 create* 入口
 */
export const WINDOW_TYPES = ['main', 'settings'] as const

export type WindowType = (typeof WINDOW_TYPES)[number]

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
   * 重建主窗口（界面上的「立即重启」）。
   *
   * 和切语言走同一条实现，但**不是**同一个通道：那条通道会先弹一个本地化的
   * 确认框。设置界面的重启已经问过用户了，再问一遍是重复确认。
   */
  restart: 'host:restart-app',
  /**
   * 渲染进程 / 预加载 -> 主进程的日志转发。
   *
   * 单向 send 而不是 invoke：日志不该有回执，也不该让调用方 await —— 一条
   * 发不出去的日志不值得让任何业务流程卡住。
   */
  log: 'host:log'
} as const
