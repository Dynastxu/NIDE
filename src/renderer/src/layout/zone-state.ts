import { useLayoutStore, type ZoneId } from '@renderer/stores/layout.store'
import { usePluginStore } from '@renderer/stores/plugin.store'
import type { PluginViewDescriptor } from '@shared/plugin-api'

/**
 * 该区注册了哪些视图。
 *
 * 注意选择器只取整个 views 数组，filter() 放在组件体内 —— zustand v5 的选择器
 * 一旦每次返回新数组，useSyncExternalStore 会认为快照一直在变而无限重渲染。
 */
export function useZoneViews(id: ZoneId): PluginViewDescriptor[] {
  const views = usePluginStore((s) => s.views)
  return views.filter((v) => v.location === id)
}

/** 该区有没有视图。列表还没加载完时先当作「有」，避免首帧闪一下 */
export function useZoneHasViews(id: ZoneId): boolean {
  const loaded = usePluginStore((s) => s.loaded)
  const count = useZoneViews(id).length
  if (!loaded) return true
  return count > 0
}

/**
 * 开关打开 && 该区确实有内容 —— 决定这个区（以及它所在的列）是否占位。
 *
 * 分开写两次 hook 调用是刻意的：写成 visible && useZoneHasViews(id) 会因为
 * 短路求值导致 hook 调用数量随渲染变化，直接触发 React 的 hook 顺序错误。
 */
export function useZoneActive(id: ZoneId): boolean {
  const visible = useLayoutStore((s) => s.zones[id].visible)
  const hasViews = useZoneHasViews(id)
  return visible && hasViews
}

/** 该区当前该展示哪个视图；区被关掉或没有视图时返回 null */
export function useActiveView(id: ZoneId): PluginViewDescriptor | null {
  const views = useZoneViews(id)
  const visible = useLayoutStore((s) => s.zones[id].visible)
  const activeViewId = useLayoutStore((s) => s.zones[id].activeViewId)

  if (!visible) return null
  return views.find((v) => v.id === activeViewId) ?? views[0] ?? null
}
