import { JSX } from 'react'
import { WorkbenchLayout } from '@nide/client-ui-main/layout/WorkbenchLayout'
import { MainMenu } from '@nide/client-ui-main/window/MainMenu'
import { SettingsMenu } from '@nide/client-kit/window/SettingsMenu'
import { WindowFrame } from '@nide/client-kit/window/WindowFrame'
import { useWindowTitle } from '@nide/client-kit/window/useWindowTitle'
import { EntryActionHost } from '@nide/client-ui-main/entry/EntryActionHost'

/**
 * 主窗口。
 *
 * 标题栏从左上到右上依次是：
 *
 * ```
 * 默认： NIDE  [☰]  [项目 ▾]                       [设置 ▾]  —  □  ✕
 * 菜单： NIDE  [☰]  文件  编辑                      [设置 ▾]  —  □  ✕
 * ```
 *
 * - **标题只有应用名**，不带项目名：项目名由菜单按钮右边那一栏显示（默认那一栏就是
 *   项目下拉），而它是一个能换项目的选择器，比一段只读文字有用。任务栏 / Alt-Tab 上
 *   的标题仍然带项目名（见 shared/window 的 systemWindowTitle）—— 那里没有下拉可看。
 * - 「菜单按钮 + 项目下拉 / 菜单栏」是**一格两栏**、一次只显示一栏，所以它们由同一个
 *   组件（`MainMenu`）拥有；「设置」在最右边，走 `actions`。菜单里的「提交」打开的
 *   提交页是登记在视图表里的视图（`host.commit`），不是这一层画的浮层。
 *
 * 内容区仍然是工作台，和工作台怎么排、有哪些工具区无关。
 *
 * 这里不叫 App.tsx：那个名字留给「挂载 + 加载 view 列表」的启动编排，
 * 这一层纯粹是主窗口的**外观装配**。
 */
export function MainApp(): JSX.Element {
  const title = useWindowTitle()

  return (
    <>
      <WindowFrame title={title} leading={<MainMenu />} actions={<SettingsMenu />}>
        <WorkbenchLayout />
      </WindowFrame>

      {/*
        条目动作的浮层（名字输入框、失败提示）挂在**窗口骨架之外**：它是浮层，不该
        跟着内容区一起被 `overflow-hidden` 裁掉，而且与任何一块面板都无关 ——
        文件树与章节列表用的是同一份（见 entry/EntryActionHost）。

        只挂主窗口：条目动作只在这里存在。这与 ConfirmHost「每种窗口都挂一次」的理由
        不同 —— 那个接的是主进程在**任何**窗口上都可能发起的二次确认。
      */}
      <EntryActionHost />
    </>
  )
}
