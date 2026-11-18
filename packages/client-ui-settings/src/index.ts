import type { Context } from 'cordis'
import { slotsOf } from '@nide/client-ui-slots'
import { SettingsApp } from './SettingsApp'

/**
 * 设置窗口的 client 插件。
 *
 * 组件本体就在这个包里：设置树 / 各设置页 / 插件设置页的挂载点。
 * 插件浏览（`PluginsBrowser`）与重启提示（`RestartDialog`）**不**在这里 ——
 * 欢迎窗口的「插件」页也要用它们，所以它们住在功能包 `@nide/client-ui-plugins`，
 * 两个窗口各自 import。跨窗口 import 另一个窗口的组件是上一轮清掉的那条债。
 */
export { SettingsApp } from './SettingsApp'
export { PluginSettingsSlot } from './PluginSettingsSlot'

/** 这个包负责的窗口种类（client-runtime 按它装配，不再用 switch） */
export const windowTypes = ['settings'] as const

export const settingsPlugin = {
  name: 'nide-client-ui-settings',
  inject: ['slots'],
  apply(ctx: Context): void {
    const slots = slotsOf(ctx)
    ctx.effect(() => slots.register('settings.root', SettingsApp), 'settings.root')
    ctx.logger('client-ui-settings').info('settings.root registered')
  }
}

/** 花名册协议：client-runtime 按 windowTypes 过滤后挂载这里列出的插件 */
export const clientPlugins = [settingsPlugin]
