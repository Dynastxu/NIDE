import { JSX } from 'react'
import { PluginsBrowser } from '@renderer/plugins/PluginsBrowser'
import type { SettingsPageProps } from '@renderer/settings/pages'

/**
 * 设置 -> 插件。
 *
 * 界面本身在 `@renderer/plugins/PluginsBrowser` 里 —— 欢迎窗口的「插件」页用的
 * 是同一个组件（那里 `mode: 'immediate'`，勾选立刻生效）。这一层只做一件事：
 * 把设置窗口的草稿模型（脏标记、提交 / 丢弃、重启提示）接到那个组件上。
 *
 * 之所以这么分：插件列表 + 详情 + 右键菜单有一百多行，抄一份到欢迎窗口意味着
 * 以后每次改插件界面都要记得改两处。
 */
export default function PluginsPage({
  onDirtyChange,
  registerActions,
  onRestartRequired
}: SettingsPageProps): JSX.Element {
  return (
    <PluginsBrowser
      mode="deferred"
      onDirtyChange={onDirtyChange}
      registerActions={registerActions}
      onRestartRequired={onRestartRequired}
    />
  )
}
