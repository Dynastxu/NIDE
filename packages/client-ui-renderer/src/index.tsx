import { createContext, createElement, use, type JSX, type ReactNode } from 'react'
import type { SlotRegistry } from '@nide/client-ui-slots'

/**
 * slot 注册表到 React 的最小绑定。
 *
 * 关键约束：`Slot` 不产生任何包装 DOM —— 直接渲染 occupant 组件；没有注册者时
 * 渲染 `fallback`（可选），两者都没有才返回 null。工作台的布局是 flex 驱动的，
 * 多一层 div 就会把位置和伸缩改掉。
 */

const SlotContext = createContext<SlotRegistry | null>(null)

export function SlotProvider({
  registry,
  children
}: {
  registry: SlotRegistry
  children: ReactNode
}): JSX.Element {
  return <SlotContext value={registry}>{children}</SlotContext>
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
