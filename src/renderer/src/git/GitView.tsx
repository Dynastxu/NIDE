import { type JSX } from 'react'
import { HostPlaceholder } from '@renderer/host-view/HostPlaceholder'
import { useViewChrome } from '@renderer/view/chrome-context'
import { ViewFrame } from '@renderer/view/ViewFrame'

/**
 * 版本控制视图 —— 侧边按钮条**左下角**那颗按钮打开的页面。
 *
 * 视图 id 与位置见主进程的 `HOST_VIEWS`（`host.git`，页面在**底栏左半**，按钮落在
 * 左侧按钮条左下角），渲染进程这边的组件表在 `HostSlot` 里。这样它与文件树走的是
 * 同一套机制：按钮条与工具区不需要为「宿主自己的功能」再开一条路。
 *
 * 目前**只有占位**：没有仓库状态、没有分支、没有暂存区，也不读任何版本控制数据。
 * 但它已经带上了通用外壳（标题栏 + 最小化按钮），因为那是每个视图都有的那一层。
 */
export function GitView(): JSX.Element {
  const chrome = useViewChrome()

  return (
    <ViewFrame chrome={chrome}>
      <HostPlaceholder messageKey="host.git.placeholder" />
    </ViewFrame>
  )
}
