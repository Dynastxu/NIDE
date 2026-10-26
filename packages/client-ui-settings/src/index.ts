import type { Context } from '@deepseek-ai/cordis'
import { slotsOf } from '@nide/client-ui-slots'
import { SettingsApp } from './SettingsApp'

/**
 * 设置窗口的 client 插件。
 *
 * 组件本体就在这个包里：设置树 / 各设置页 / 插件浏览 / 重启提示。欢迎窗口的
 * 「插件」页复用的 `PluginsBrowser` 也从这里导出（它和设置页里的插件页是同一个
 * 组件，`mode` 决定有没有「确定 / 取消」那一条）。
 */
export { SettingsApp } from './SettingsApp'
export { PluginsBrowser } from './PluginsBrowser'
export { RestartDialog } from './RestartDialog'
export { PluginSettingsSlot } from './PluginSettingsSlot'

export const settingsPlugin = {
  name: 'nide-client-ui-settings',
  inject: ['slots'],
  apply(ctx: Context): void {
    const slots = slotsOf(ctx)
    ctx.effect(() => slots.register('settings.root', SettingsApp), 'settings.root')
    ctx.logger('client-ui-settings').info('settings.root registered')
  }
}
