import { JSX } from 'react'
import { WorkbenchLayout } from '@renderer/layout/WorkbenchLayout'
import { MainMenu } from '@renderer/window/MainMenu'
import { SettingsMenu } from '@renderer/window/SettingsMenu'
import { WindowFrame } from '@renderer/window/WindowFrame'
import { useWindowTitle } from '@renderer/window/useWindowTitle'

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
 *   组件（`MainMenu`）拥有；「设置」在最右边，走 `actions`。
 *
 * 内容区仍然是工作台，和工作台怎么排、有哪些工具区无关。
 *
 * 这里不叫 App.tsx：那个名字留给「挂载 + 加载 view 列表」的启动编排，
 * 这一层纯粹是主窗口的**外观装配**。
 */
export function MainApp(): JSX.Element {
  const title = useWindowTitle()

  return (
    <WindowFrame title={title} leading={<MainMenu />} actions={<SettingsMenu />}>
      <WorkbenchLayout />
    </WindowFrame>
  )
}
