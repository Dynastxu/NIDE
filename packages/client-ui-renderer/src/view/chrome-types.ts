import type {
  ViewChromeController,
  ViewMoreItem,
  ViewTab,
  ViewTabCloseIcon,
  ViewTabStrip
} from '@nide/contracts/plugin-api'

/**
 * 视图外壳的**类型**。
 *
 * 与 `shared/plugin-api` 的分工：那里是跨进程的契约（manifest、IPC 下发的描述），
 * 这里是渲染进程内部的形状 —— 合并之后、绘制之前的那一份。两者字段相近但不该合并：
 * 契约要能被结构化克隆，而这里带着函数（标签页动作、菜单回调）。
 */

/**
 * 视图可以改的那些开关，逐项覆盖静态声明。
 *
 * 命名与 `ViewChromeOptions` 有意不同：那边是 manifest 里的静态声明（`header` /
 * `title` / `more` / `minimize` / `tabs`，回答「要不要这个能力」），这里是渲染期的
 * 覆盖（`showHeader` / `showTitle` / …，回答「现在画不画」）。同一个视图完全可能
 * 声明了标题栏能力、却在一部分状态下不画它 —— 主编辑区一个文件都没打开时就是。
 */
export interface ViewChromePatch {
  showHeader?: boolean
  showTitle?: boolean
  showMore?: boolean
  showMinimize?: boolean
  showTabs?: boolean
  tabStrip?: ViewTabStrip
  tabsClosable?: boolean
  closeIcon?: ViewTabCloseIcon
}

/**
 * 视图外壳的完整状态：静态开关 + 运行期内容。
 *
 * 是**完整**字段而不是 Partial —— 合并只发生在 `buildChromeConfig` 里，到了绘制
 * 那一层再缺字段，`ViewFrame` 就得到处写 `?? true`。
 */
export interface ViewChromeConfig {
  /** 标题栏那一行。false 时只剩视图正文 */
  header: boolean
  /** 标题栏左侧的标题文字 */
  title: string
  /** 显示标题文字 */
  showTitle: boolean
  /** 允许显示「更多」按钮（没有菜单项时依然不画，见 ViewFrame 的 FrameControls） */
  showMore: boolean
  /** 显示最小化按钮 */
  showMinimize: boolean
  /** 在标题栏里画标签条 */
  showTabs: boolean
  /** 标签条样式 */
  tabStrip: ViewTabStrip
  /** 标签条里的标签页。空数组 = 没有标签条 */
  tabs: ViewTab[]
  /** 当前标签页。整条标签条靠它高亮，dropdown 样式靠它取按钮文案 */
  activeTabId: string | null
  /** 标签默认能不能关 */
  tabsClosable: boolean
  /** 标签默认的关闭按钮形状 */
  closeIcon: ViewTabCloseIcon
  /** 标签页的选中 / 关闭动作。视图没给时是空实现 */
  controller: ViewChromeController
  /** 「更多」按钮点开后的菜单项。空数组 = 不画按钮 */
  moreItems: ViewMoreItem[]
}

/**
 * 视图在渲染期给出的外壳内容。
 *
 * 所有字段都可省略：视图只声明它在意的那些，其余落到「视图的静态声明 -> 宿主
 * 默认值（全开）」这条链上。
 */
export interface ViewChromeInput {
  /** 覆盖标题文字 */
  title?: string
  /** 覆盖静态开关 */
  configure?: ViewChromePatch
  /** 标签页 */
  tabs?: ViewTab[]
  activeTabId?: string | null
  /** 「更多」菜单项 */
  moreItems?: ViewMoreItem[]
  /** 标签页的选中 / 关闭动作 */
  controller?: ViewChromeController
}
