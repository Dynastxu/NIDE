import type { JSX, ReactNode } from 'react'
import { ClientStoresContext, type ClientStores } from './client-stores'

/**
 * 把一套 store 实例交给 React 树。
 *
 * 单独一个文件是为了 `react-refresh` 只看到组件导出；挂载点在渲染进程的引导壳
 * （`apps/desktop/renderer/src/main.tsx`），与 `<SlotProvider>` 同一层 —— 树里所有
 * 组件（窗口、插件视图、设置页）因此看到的是**同一套** store。
 */
export function ClientStoresProvider({
  stores,
  children
}: {
  stores: ClientStores
  children: ReactNode
}): JSX.Element {
  return <ClientStoresContext value={stores}>{children}</ClientStoresContext>
}
