import { type JSX } from 'react'
import { HostPlaceholder } from '@nide/client-kit/ui/HostPlaceholder'
import { useViewChrome } from '@nide/client-ui-renderer/view/chrome-context'
import { ViewFrame } from '@nide/client-ui-renderer/view/ViewFrame'

/**
 * 提交视图 —— 标题栏「文件 -> 提交」打开的页面。
 *
 * 入口在菜单里（见主窗口的 `window/MainMenu`），但页面本体仍然是一个**登记在视图表
 * 里的视图**（`host.commit`）：菜单只负责把所在的区切到它，不再自己维护一套浮层。
 * 组件在**这个功能包**里，由 `gitPlugin` 注册到 `hostViewSlotName(HOST_COMMIT_VIEW_ID)`。
 *
 * 目前**只有占位**：没有改动列表、没有提交信息输入框，也不写任何东西。
 */
export function CommitView(): JSX.Element {
  const chrome = useViewChrome()

  return (
    <ViewFrame chrome={chrome}>
      <HostPlaceholder messageKey="host.commit.placeholder" />
    </ViewFrame>
  )
}
