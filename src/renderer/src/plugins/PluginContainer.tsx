import { useEffect, type JSX } from 'react'
import { usePluginStore } from '../stores/plugin.store'
import { PluginSlot } from './PluginSlot'

interface Props {
  location: 'sidebar' | 'panel' | 'main'
}

export function PluginContainer({ location }: Props): JSX.Element {
  const views = usePluginStore((s) => s.views)
  const loaded = usePluginStore((s) => s.loaded)
  const loadViews = usePluginStore((s) => s.loadViews)

  useEffect(() => {
    if (!loaded) void loadViews()
  }, [loaded, loadViews])

  if (!loaded) {
    return <div className="p-3 text-xs text-zinc-500">加载插件视图…</div>
  }

  const filtered = views.filter((v) => v.location === location)
  if (filtered.length === 0) {
    return <div className="p-3 text-xs text-zinc-600">[{location}] 没有插件视图</div>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {filtered.map((v) => (
        <div
          key={v.id}
          className="flex min-h-0 flex-1 flex-col border-b border-zinc-800 last:border-b-0"
        >
          <div className="shrink-0 px-3 py-1 text-xs text-zinc-400">{v.title}</div>
          <div className="min-h-0 flex-1">
            <PluginSlot viewId={v.id} />
          </div>
        </div>
      ))}
    </div>
  )
}
