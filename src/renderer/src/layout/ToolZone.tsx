import { JSX } from 'react'
import { PluginSlot } from '@renderer/plugins/PluginSlot'
import { useActiveView } from '@renderer/layout/zone-state'
import type { ZoneId } from '@renderer/stores/layout.store'

/**
 * 单个工具区：只有插件视图本体，没有宿主标题栏。
 *
 * 视图名由侧边按钮条在图标下面显示 —— 宿主不在内容区里重复一遍标题，
 * 这行高度全部让给插件。收起这个区的入口也是按钮条上那个按钮（再点一次）。
 */
export function ToolZone({ id }: { id: ZoneId }): JSX.Element | null {
  const view = useActiveView(id)

  // useActiveView 已经把「区被关掉」和「区里没有视图」两种情况都归成 null
  if (!view) return null

  return (
    <section className="h-full overflow-hidden bg-zinc-950/30">
      {/* key 换掉时 PluginSlot 会重新按 viewId 加载模块 */}
      <PluginSlot key={view.id} viewId={view.id} />
    </section>
  )
}
