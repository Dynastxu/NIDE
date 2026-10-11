import { type JSX } from 'react'
import { HostPlaceholder } from '@renderer/host-view/HostPlaceholder'

/**
 * 提交视图 —— 标题栏「文件 -> 提交」打开的页面。
 *
 * 入口在菜单里（见 `window/MainMenu`），但页面本体仍然是一个**登记在视图表里的
 * 视图**（`host.commit`）：菜单只负责把所在的区切到它，不再自己维护一套浮层，
 * 于是它与按钮条上的那些视图共用同一套装配（`ToolZone` -> `HostSlot`）。
 *
 * 目前**只有占位**：没有改动列表、没有提交信息输入框，也不写任何东西。
 */
export function CommitView(): JSX.Element {
  return <HostPlaceholder messageKey="host.commit.placeholder" />
}
