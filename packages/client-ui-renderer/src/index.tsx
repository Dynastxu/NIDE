import { createContext, createElement, use, type JSX, type ReactNode } from 'react'
import type { SlotRegistry } from '@nide/client-ui-slots'
import type { ClientModuleRegistry } from '@nide/client-modules'
import { ModulesContext } from './modules-context'

/**
 * slot / 模块注册表到 React 的最小绑定 —— 也是**宿主渲染管线**的家。
 *
 * 关键约束：`Slot` 不产生任何包装 DOM —— 直接渲染 occupant 组件；没有注册者时
 * 渲染 `fallback`（可选），两者都没有才返回 null。工作台的布局是 flex 驱动的，
 * 多一层 div 就会把位置和伸缩改掉。
 *
 * 为什么模块注册表、视图外壳（`view/`）也在这里：它们都是「宿主怎么把一个视图画
 * 出来」的机械，而不是某个窗口的业务。插件要拿视图外壳（`useViewChrome` /
 * `ViewFrame`）时 import 这个包 —— 它属于渲染面，不属于任何一扇窗。
 */

const SlotContext = createContext<SlotRegistry | null>(null)

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

export function Slot({ name, fallback = null }: { name: string; fallback?: ReactNode }): ReactNode {
  const registry = use(SlotContext)
  if (!registry) return fallback

  const Component = registry.get(name)
  if (!Component) return fallback

  // 用 createElement 而不是 JSX：组件来自注册表，不是渲染期新建的；
  // 这么写也避免 lint 把 `const Component = ...` 误判成动态组件。
  return createElement(Component)
}
