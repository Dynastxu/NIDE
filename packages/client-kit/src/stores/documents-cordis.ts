import type { Context } from 'cordis'
import { useDocumentsStore } from './documents.store'

/**
 * 文档状态在客户端 Cordis 上的服务面（`ctx.documents`）。
 *
 * React 组件直接用 `useDocumentsStore`；非 React 的客户端插件（以后独立出去的
 * explorer / editor 包里的 `apply`）注入 `['documents']`，再用 `documentsOf(ctx)`
 * 拿到同一个 store。这样功能包之间不需要 import 对方的 store。
 *
 * 取法照 `slotsOf`：不做模块增强（`declare module 'cordis'` 会遮蔽 Context 的
 * 其他成员），用显式 `ctx.get`。`provide` 同样走结构化调用 —— Cordis 的
 * `Context.provide` 类型要求 key 先出现在接口上，这里绕开它。
 */
export type DocumentsStore = typeof useDocumentsStore

export function installDocuments(ctx: Context): void {
  const provide = (
    ctx as unknown as { provide: (name: string, value: unknown) => void }
  ).provide.bind(ctx)
  provide('documents', useDocumentsStore)
}

export function documentsOf(ctx: Context): DocumentsStore {
  const service = ctx.get('documents')
  if (!service) throw new Error('documents service is not provided on this context')
  return service as DocumentsStore
}
