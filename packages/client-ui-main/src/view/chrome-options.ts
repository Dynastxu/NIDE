import {
  DEFAULT_VIEW_CHROME,
  type ViewChromeController,
  type ViewChromeOptions
} from '@nide/contracts/plugin-api'
import type {
  ViewChromeConfig,
  ViewChromeInput,
  ViewChromePatch
} from '@nide/client-ui-main/view/chrome-types'

/**
 * 外壳开关与内容的**纯计算**。
 *
 * 这个文件里没有 React、没有组件：合并规则是全套外壳里最需要被单测钉住的一段
 * （默认值写错一个字段，界面上就是某个视图的标题栏或按钮凭空消失），而它本来
 * 就与渲染无关。`react-refresh` 也要求「只导出组件的文件别夹带普通函数」，
 * 两边正好一致。
 */

/**
 * `resolveChromeOptions` 收的那种「半份开关」。
 *
 * 两种形状的字段名不同：静态声明用 `title` / `more` / `minimize`，运行期覆盖用
 * `showTitle` / `showMore` / `showMinimize`（前者是「要不要」，后者是「现在要不要」）。
 * 两层要能一起传进来，所以合并在一个函数里做 —— 少合并一层只会表现为
 * 「某一项明明声明了却不生效」，那是最难查的一类。
 */
export type ChromeOptionPatch = ViewChromeOptions & ViewChromePatch

/**
 * 把视图声明的开关补齐成完整开关。
 *
 * 合并顺序：宿主默认值 -> 各层声明。**默认全开**，所以一个什么都不声明的视图也会
 * 得到标题栏、标题和最小化按钮 —— 这是「所有视图都有标题栏」这条约定的落点。
 */
export function resolveChromeOptions(
  ...patches: readonly (ChromeOptionPatch | undefined)[]
): Required<ViewChromeOptions> {
  const resolved: Required<ViewChromeOptions> = { ...DEFAULT_VIEW_CHROME }

  for (const patch of patches) {
    if (!patch) continue

    resolved.header = patch.header ?? resolved.header
    resolved.title = patch.title ?? resolved.title
    resolved.more = patch.more ?? resolved.more
    resolved.minimize = patch.minimize ?? resolved.minimize
    resolved.tabs = patch.tabs ?? resolved.tabs
  }

  return resolved
}

/**
 * 把开关与运行期内容拼成一份完整配置。
 *
 * 几条默认值值得单独说：**默认画**标题栏、标题、更多按钮、最小化按钮、标签条，
 * 唯一的例外是标签页的可关闭性 —— 标签页承载的是「这个视图的哪一面」，关掉它通常
 * 没有意义（视图还在，只是少了一页），所以那个能力要由视图显式打开。
 */
export function buildChromeConfig(
  options: Required<ViewChromeOptions>,
  title: string,
  input: ViewChromeInput | null | undefined
): ViewChromeConfig {
  const configure = input?.configure
  const tabs = input?.tabs ?? []

  /**
   * 每一项的取值都是「运行期覆盖 -> 视图的静态声明」，也就是静态声明只是**默认值**。
   *
   * 这一点值得写清楚：manifest 里的 `chrome` 是一份静态 JSON，写得再细也说不出
   * 「只有在有内容时才画标题栏」这类条件（主编辑区一个文件都没打开时就是那样），
   * 而视图自己的代码说得出 —— 那它就该说了算。反过来，视图没提的那几项照旧落到
   * 静态声明上，所以「声明了却没有运行时覆盖」仍然完全按声明走。
   */
  return {
    header: configure?.showHeader ?? options.header,
    /**
     * 视图可以在渲染期改标题：标题栏上的文案常常比「这个视图叫什么」更具体
     * （编辑器显示的就是当前文件），而 manifest 里那个是静态的。
     */
    title: input?.title ?? title,
    showTitle: configure?.showTitle ?? options.title,
    showMore: configure?.showMore ?? options.more,
    showMinimize: configure?.showMinimize ?? options.minimize,
    /** 没有标签就没有标签条：一条空的标签行只是白白占掉一行高度 */
    showTabs: (configure?.showTabs ?? options.tabs) && tabs.length > 0,
    tabStrip: configure?.tabStrip ?? 'flat',
    tabs,
    activeTabId: input?.activeTabId ?? null,
    tabsClosable: configure?.tabsClosable ?? false,
    closeIcon: configure?.closeIcon ?? 'close',
    controller: input?.controller ?? NO_CONTROLLER,
    moreItems: input?.moreItems ?? []
  }
}

/** 视图没有给动作时的占位：标签条照样画，只是点了什么都不发生 */
export const NO_CONTROLLER: ViewChromeController = { selectTab: () => {}, closeTab: () => {} }

/**
 * 内容的指纹。
 *
 * 用 JSON 而不是逐字段比较：内容形状是固定的纯数据（标签、菜单项、几个开关），
 * 序列化一次比手写十几次比较更不容易漏项。**函数字段被剔除** —— 菜单项上的
 * `onSelect` 与标签页上的动作每次渲染都是新引用，拿它们当判据等于每帧都重算。
 */
export function describeChromeInput(input: ViewChromeInput | undefined): string {
  if (!input) return ''

  return JSON.stringify({
    title: input.title,
    configure: input.configure,
    tabs: input.tabs,
    activeTabId: input.activeTabId,
    // 只取纯数据字段：onSelect 每次渲染都是新函数，带上它等于每帧都重算
    moreItems: input.moreItems?.map((item) => ({
      id: item.id,
      label: item.label,
      icon: item.icon,
      disabled: item.disabled,
      disabledReason: item.disabledReason,
      danger: item.danger
    }))
  })
}

/**
 * 视图描述里与外壳有关的那几项。
 *
 * 用它当 `useMemo` 的依赖，避免描述每次渲染换新对象时白算一遍。
 */
export function describeViewChrome(
  descriptor: { id: string; title: string; chrome?: ViewChromeOptions } | null | undefined
): string {
  if (!descriptor) return ''

  return `${descriptor.id}\u0000${descriptor.title}\u0000${JSON.stringify(descriptor.chrome ?? null)}`
}
