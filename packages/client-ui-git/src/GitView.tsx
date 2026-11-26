import { type JSX } from 'react'
import { HostPlaceholder } from '@nide/client-kit/ui/HostPlaceholder'
import { useViewChrome } from '@nide/client-ui-renderer/view/chrome-context'
import { ViewFrame } from '@nide/client-ui-renderer/view/ViewFrame'

/**
 * 版本控制视图 —— 侧边按钮条**左下角**那颗按钮打开的页面。
 *
 * 视图 id 与位置仍由 host 的 git 服务（`host.git`，页面在**底栏左半**）登记；
 * 组件在**这个功能包**里，由 `gitPlugin` 注册到 `hostViewSlotName(HOST_GIT_VIEW_ID)`。
 * 主窗口只负责分区与 slot，不 import 这里的任何东西。
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
