import { JSX } from 'react'
import { PluginSlot } from '@renderer/plugins/PluginSlot'
import { useActiveView } from '@renderer/layout/zone-state'
import { useLayoutStore, type ZoneId } from '@renderer/stores/layout.store'

/**
 * 单个工具区：标题栏（当前视图名 + 隐藏按钮）+ 该视图本体。
 *
 * 一个区同时只展示一个视图 —— 切换靠侧边按钮条上对应的那个按钮，
 * 所以这里不再需要页签。
 */
export function ToolZone({ id }: { id: ZoneId }): JSX.Element | null {
  const setVisible = useLayoutStore((s) => s.setVisible)
  const view = useActiveView(id)

  // useActiveView 已经把「区被关掉」和「区里没有视图」两种情况都归成 null
  if (!view) return null

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-zinc-950/30">
      <header className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-zinc-800 px-2">
        <span className="truncate text-[11px] tracking-wide text-zinc-400">{view.title}</span>
        <button
          type="button"
          title={`隐藏${view.title}`}
          aria-label={`隐藏${view.title}`}
          onClick={() => setVisible(id, false)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        >
          ×
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        {/* key 换掉时 PluginSlot 会重新按 viewId 加载模块 */}
        <PluginSlot key={view.id} viewId={view.id} />
      </div>
    </section>
  )
}
