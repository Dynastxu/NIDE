import { JSX } from 'react'
import { WorkbenchLayout } from '@renderer/layout/WorkbenchLayout'
import { SettingsMenu } from '@renderer/window/SettingsMenu'
import { WindowFrame } from '@renderer/window/WindowFrame'
import { useT } from '@renderer/stores/i18n.store'

/**
 * 主窗口。
 *
 * 只做一件事：把工作台包进共用的窗口骨架（自定义标题栏）。
 * 工作台自己不知道标题栏的存在 —— 这样换布局、换标题栏都不会互相牵动。
 *
 * 「设置」按钮是**主窗口自己的**标题栏动作，通过 actions 挂进去：子窗口不传
 * 就没有，不会出现「设置窗口里还有一个设置按钮」这种循环入口。
 *
 * 这里不叫 App.tsx：那个名字留给「挂载 + 加载 view 列表」的启动编排，
 * 这一层纯粹是主窗口的**外观装配**。
 */
export function MainApp(): JSX.Element {
  const t = useT()

  return (
    <WindowFrame title={t('host.app.title')} actions={<SettingsMenu />}>
      <WorkbenchLayout />
    </WindowFrame>
  )
}
