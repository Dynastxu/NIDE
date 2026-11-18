import { createContext, use } from 'react'
import type { ClientModuleRegistry } from '@nide/client-modules'

/**
 * 插件视图组件表的 React 通道。
 *
 * 单独一个文件（不放 `index.tsx`）是为了让 `react-refresh` 仍然只看到组件导出：
 * 一个文件同时导出组件和 hook 时，热更新会退化成整页刷新。
 *
 * 注册表本身来自 `client-modules`，由引导壳经 `<SlotProvider modules>` 传进来 ——
 * 渲染管线不 import 客户端树（那会成环），也不持有模块级单例。
 */
export const ModulesContext = createContext<ClientModuleRegistry | null>(null)

/**
 * 取插件视图组件表。
 *
 * 返回 null 是正常状态（客户端树没起来 / 单测直接渲染）：`PluginSlot` 那时回退到
 * 构建期 glob 的那张表，界面不受影响。
 */
export function useClientModules(): ClientModuleRegistry | null {
  return use(ModulesContext)
}
