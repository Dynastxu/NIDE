import { JSX } from 'react'
import { HostSlot } from '@renderer/plugins/HostSlot'
import { PluginSlot } from '@renderer/plugins/PluginSlot'
import { useActiveView } from '@renderer/layout/zone-state'
import { HOST_VIEW_PLUGIN_ID } from '@shared/plugin-api'
import type { ZoneId } from '@renderer/stores/layout.store'

/**
 * 单个工具区：只有视图本体，没有宿主标题栏。
 *
 * 视图名由侧边按钮条在图标下面显示 —— 宿主不在内容区里重复一遍标题，
 * 这行高度全部让给视图。收起这个区的入口也是按钮条上那个按钮（再点一次）。
 *
 * 视图分两类，**出口只有这一个**：
 *
 * - 插件视图：按 `dir` / `entry` 去构建期的 glob 表里找模块（PluginSlot）；
 * - 宿主内建视图（文件树）：组件直接编译在宿主里（HostSlot）。
 *
 * 之所以让它们共用同一个组件，是因为「哪个区展示谁」由布局 store 的
 * activeViewId 决定，而那个判断不该知道视图是谁提供的。区分只发生在最后一步。
 */
export function ToolZone({ id }: { id: ZoneId }): JSX.Element | null {
  const view = useActiveView(id)

  // useActiveView 已经把「区被关掉」和「区里没有视图」两种情况都归成 null
  if (!view) return null

  const isHostView = view.pluginId === HOST_VIEW_PLUGIN_ID

  return (
    <section className="h-full overflow-hidden bg-zinc-950/30">
      {/* key 换掉时插槽会重新按 viewId 挂载（插件视图要重新加载模块） */}
      {isHostView ? (
        <HostSlot key={view.id} viewId={view.id} />
      ) : (
        <PluginSlot key={view.id} viewId={view.id} />
      )}
    </section>
  )
}
