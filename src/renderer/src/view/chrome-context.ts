import { useContext, useMemo } from 'react'
import {
  buildChromeConfig,
  describeChromeInput,
  describeViewChrome,
  resolveChromeOptions
} from '@renderer/view/chrome-options'
import { ViewDescriptorContext } from '@renderer/view/view-descriptor'
import type { ViewChromeConfig, ViewChromeInput } from '@renderer/view/chrome-types'

/**
 * 视图外壳（标题栏 + 标签条）的入口。
 *
 * 分工是刻意的，三块各归一处：
 *
 * 1. **静态开关**（要不要标题栏、标题、更多按钮、最小化按钮、标签条）由视图声明：
 *    写在 manifest 的 `chrome` 字段里，或在渲染期用 `configure` 改。
 * 2. **内容**（标签列表、更多菜单的条目、标题栏里的按钮）由视图在渲染期给出 ——
 *    它们随视图状态变化，而 manifest 是启动时读一次的静态 JSON。
 * 3. **外壳的绘制**归宿主（`ViewFrame`）：视图给数据，怎么排、怎么点、点外怎么关
 *    全在那一层。让每个视图自己画，六个区迟早会长成六种样子。
 *
 * ## 一条装配约定
 *
 * 视图正文的最外层是它**自己**的 `ViewFrame`，配置来自这里：
 *
 * ```tsx
 * const chrome = useViewChrome({ tabs, activeTabId, controller: { selectTab, closeTab } })
 * return (
 *   <ViewFrame chrome={chrome} slots={{ tabs: { after: <AddButton /> } }}>
 *     正文
 *   </ViewFrame>
 * )
 * ```
 *
 * 宿主**不**替视图渲染外壳：视图自己挂的按钮带着它这一帧的闭包（「加号」要知道往
 * 哪个数组里加），把按钮交给宿主保管就必须在「每帧都推」（渲染成环）与「推一次之后
 * 闭包过期」之间二选一。外壳与正文同属视图，这条约定就没有那个问题。
 *
 * 视图描述（标题、图标、manifest 里的静态开关）由宿主经 `ViewDescriptorContext`
 * 放进来，所以上面的调用不必传任何参数。
 */
export function useViewChrome(input?: ViewChromeInput): ViewChromeConfig {
  const descriptor = useContext(ViewDescriptorContext)

  /** 静态开关：描述里的 manifest 声明打底，运行期的 configure 由 buildChromeConfig 覆盖 */
  const options = useMemo(() => resolveChromeOptions(descriptor?.chrome), [descriptor?.chrome])

  const viewKey = describeViewChrome(descriptor)
  const inputFingerprint = describeChromeInput(input)

  return useMemo(
    () => buildChromeConfig(options, descriptor?.title ?? '', input),
    // input 每次渲染都是新对象，真正的依赖是它的内容指纹（describeChromeInput）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options, viewKey, inputFingerprint]
  )
}

export type {
  ViewChromeConfig,
  ViewChromeInput,
  ViewChromePatch
} from '@renderer/view/chrome-types'
