import { type JSX } from 'react'
import { HostPlaceholder } from '@nide/client-ui-main/host-view/HostPlaceholder'
import { useViewChrome } from '@nide/client-ui-main/view/chrome-context'
import { ViewFrame } from '@nide/client-ui-main/view/ViewFrame'

/**
 * 提交视图 —— 标题栏「文件 -> 提交」打开的页面。
 *
 * 入口在菜单里（见 `window/MainMenu`），但页面本体仍然是一个**登记在视图表里的
 * 视图**（`host.commit`）：菜单只负责把所在的区切到它，不再自己维护一套浮层，
 * 于是它与按钮条上的那些视图共用同一套装配（`ToolZone` -> `HostSlot` -> 外壳）。
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
