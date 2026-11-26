import {
  createContext,
  createElement,
  use,
  useCallback,
  useSyncExternalStore,
  type JSX,
  type ReactNode
} from 'react'
import { resolveSlot, type SlotEntry, type SlotRegistry } from '@nide/client-ui-slots'
import type { ClientModuleRegistry } from '@nide/client-modules'
import { ModulesContext } from './modules-context'

/**
 * slot / 模块注册表到 React 的最小绑定 —— 也是**宿主渲染管线**的家。
 *
 * 关键约束：`Slot` 不产生任何包装 DOM —— 直接渲染 occupant 组件；没有注册者时
 * 渲染 `fallback`（可选），两者都没有才返回 null。工作台的布局是 flex 驱动的，
 * 多一层 div 就会把位置和伸缩改掉。
 *
 * 三种槽（single / keyed / list）都由一个 `Slot` 入口渲染：种类由注册表的
 * `declare` 决定，选择逻辑在 `resolveSlot`（纯函数，可单测）。用
 * `useSyncExternalStore` 订阅注册表，晚注册的功能包也能出现。
 *
 * 为什么模块注册表、视图外壳（`view/`）也在这里：它们都是「宿主怎么把一个视图画
 * 出来」的机械，而不是某个窗口的业务。插件要拿视图外壳（`useViewChrome` /
 * `ViewFrame`）时 import 这个包 —— 它属于渲染面，不属于任何一扇窗。
 */

const SlotContext = createContext<SlotRegistry | null>(null)

/** registry 还没注入时的稳定空快照（useSyncExternalStore 要求引用稳定） */
const NO_ENTRIES: readonly SlotEntry[] = Object.freeze([])

export function SlotProvider({
  registry,
  modules,
  children
}: {
  registry: SlotRegistry
  /** 插件视图组件表；不给时 `PluginSlot` 只走构建期 glob 兜底 */
  modules?: ClientModuleRegistry | null
  children: ReactNode
}): JSX.Element {
  return (
    <SlotContext value={registry}>
      <ModulesContext value={modules ?? null}>{children}</ModulesContext>
    </SlotContext>
  )
}

export function Slot({
  name,
  activeKey,
  fallback = null
}: {
  name: string
  /** keyed 槽当前选中的 key；single / list 忽略 */
  activeKey?: string
  fallback?: ReactNode
}): ReactNode {
  const registry = use(SlotContext)

  // 三个 hook 都必须无条件调用：registry 可能从 null 变成实例（SlotProvider 在
  // 外层先挂载），不能在 useSyncExternalStore 之前提前 return。
  const subscribe = useCallback(
    (listener: () => void) => (registry ? registry.subscribe(name, listener) : () => {}),
    [registry, name]
  )
  const getSnapshot = useCallback(
    () => (registry ? registry.snapshot(name) : NO_ENTRIES),
    [registry, name]
  )
  const entries = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  if (!registry) return fallback

  const selected = resolveSlot(registry.kindOf(name), entries, activeKey)
  if (selected.length === 0) return fallback

  // single 保持「一个组件」的形状；list 按 order 全部渲染，不加包装 DOM。
  if (selected.length === 1) return createElement(selected[0].component)

  return selected.map((entry) => createElement(entry.component, { key: entry.id }))
}
