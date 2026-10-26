import { JSX } from 'react'
import { HostSlot } from '@nide/client-ui-main/plugins/HostSlot'
import { PluginSlot } from '@nide/client-kit/plugin-views/PluginSlot'
import { useActiveView } from '@nide/client-ui-main/layout/zone-state'
import { ViewDescriptorContext } from '@nide/client-ui-main/view/view-descriptor'
import { HOST_VIEW_PLUGIN_ID } from '@shared/plugin-api'
import type { ZoneId } from '@nide/client-kit/stores/layout.store'

/**
 * 单个工具区：一个视图，外壳与正文都由视图自己给。
 *
 * 这个组件只做三件事：
 *
 * 1. 把「现在展示哪个视图」解析出来（布局 store 的 activeViewId）；
 * 2. 把视图描述**放进上下文** —— 视图正文里调用 `useViewChrome()` 时要靠它拿到
 *    标题、图标与 manifest 里声明的静态开关；
 * 3. 把正文交给对应的插槽（宿主内建视图走 HostSlot，插件视图走 PluginSlot）。
 *
 * 外层**不**替视图画标题栏：外壳与正文同属视图，视图自己挂的按钮才带着它这一帧的
 * 闭包（见 view/chrome-context 的装配约定）。这样六个区与中间主编辑区是同一套外壳，
 * 而每个视图仍然可以只声明它要的那部分。
 *
 * 「收起这个区」的入口因此有两个 —— 按钮条上那颗按钮，和标题栏右端的最小化按钮 ——
 * 两者改的是同一份布局状态。
 */
export function ToolZone({ id }: { id: ZoneId }): JSX.Element | null {
  const view = useActiveView(id)

  // useActiveView 已经把「区被关掉」和「区里没有视图」两种情况都归成 null
  if (!view) return null

  const isHostView = view.pluginId === HOST_VIEW_PLUGIN_ID

  return (
    /**
     * key 换掉时插槽重新按 viewId 挂载：插件视图要重新加载模块，外壳也要丢掉上一个
     * 视图留下的标签与菜单。
     */
    <ViewDescriptorContext.Provider value={view}>
      {isHostView ? (
        <HostSlot key={view.id} viewId={view.id} />
      ) : (
        <PluginSlot key={view.id} viewId={view.id} />
      )}
    </ViewDescriptorContext.Provider>
  )
}
