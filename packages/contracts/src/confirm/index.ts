/**
 * 行为级二次确认的跨进程契约。
 *
 * ## 「要不要问」归主进程
 *
 * 确认是**动作的性质**，不是某个按钮的性质：删除一个文件、关掉项目、退出应用，
 * 无论从菜单、右键菜单、插件还是以后加进来的快捷键发起，都该问同一句话。所以
 * 判断与问话都在主进程的动作出口（见 `main/confirm.ts`），渲染进程只负责**画**
 * 这一个浮层，并把用户的回答送回去。
 *
 * 由此推出渲染进程这一侧的三条约束：
 * - 它不认识任何业务词条：标题、正文、按钮文案都由主进程翻好再送过来；
 * - 它不知道自己在替哪个动作问，只知道「有一个问题要显示」；
 * - 它不能替用户回答，只能**转达**回答 —— 采纳与否由主进程判断
 *   （只有被问的那个窗口的回答才算数）。
 *
 * ## 显式跳过
 *
 * 唯一能不弹确认框的方式是调用方显式写 `{ confirm: false }`（见 ConfirmOptions），
 * 用在「用户在别处刚刚答过同一个问题」的场合（例如设置窗口的「立即重启」）。
 * 默认永远是**问**：不写、写坏、写别的类型都按要问处理。
 *
 * 这一层被主进程、preload、渲染进程三方共用，所以**不能** import electron / DOM。
 */

/**
 * IPC 通道名。
 *
 * 和 WINDOW_CHANNELS 同理集中在这里：拼错通道名没有编译错误，只会在运行时静默
 * 失效 —— 而这条通道静默失效的样子是「点了什么都不发生」，最难查。
 */
export const CONFIRM_CHANNELS = {
  /** 主进程 -> 渲染进程：请把这个确认框画出来（参数 ConfirmRequest） */
  request: 'host:confirm-request',
  /** 渲染进程 -> 主进程：对某一次询问的回答（参数 ConfirmResponse） */
  respond: 'host:confirm-response'
} as const

/**
 * 一次询问。文案已经是**当前语言**的成品，渲染进程直接摆上去。
 */
export interface ConfirmRequest {
  /**
   * 这一次询问的编号。
   *
   * 回答必须带着它：主进程可能同时问着不止一件事（比如关窗那一问还挂着时又来了
   * 一次删除），只有编号能把回答对上是哪一问。
   */
  id: string
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  /**
   * 破坏性动作。
   *
   * 影响两处：确认按钮用红色，以及**初始焦点落在「取消」上** —— 让回车直接落在
   * 不可逆的那一步上不合适（与主进程切语言确认框同一条理由）。
   */
  danger: boolean
}

/** 对一个询问的回答 */
export interface ConfirmResponse {
  /** 回答的是哪一问 */
  id: string
  /** true = 用户点了确认，false = 用户点了取消（或者用 Esc 关掉了浮层） */
  confirmed: boolean
}

/**
 * 可确认动作的调用参数。
 *
 * `confirm: false` 是**唯一的**跳过方式，且必须由调用方写出来：它是一句声明
 * 「这个动作的用户意图我刚才已经问清楚了」，写出来才看得见、才查得到。默认
 * （不传）一律要问。
 */
export interface ConfirmOptions {
  confirm?: boolean
}

/**
 * 这次调用要不要问。
 *
 * 载荷从 IPC 进来时**完全不可信**，所以只有**显式的 `false`** 才算「不用问」：
 * 别的任何值（undefined、字符串、坏对象）都按「要问」处理。默认值必须站在
 * 安全的那一侧 —— 猜错的代价是一句多余的确认框，而不是一次静默的删除。
 */
export function confirmRequested(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return true
  return (raw as ConfirmOptions).confirm !== false
}

/**
 * 校验一个回答的形状。
 *
 * 与所有 IPC 出口同一条约定：进来的东西逐字段确认类型，确认不过就丢掉，绝不拿它
 * 去查表。
 */
export function parseConfirmResponse(raw: unknown): ConfirmResponse | null {
  if (!raw || typeof raw !== 'object') return null

  const { id, confirmed } = raw as Partial<ConfirmResponse>
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof confirmed !== 'boolean') return null

  return { id, confirmed }
}
