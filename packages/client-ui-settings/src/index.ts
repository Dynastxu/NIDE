import type { Context } from '@deepseek-ai/cordis'
import { slotsOf } from '@nide/client-ui-slots'
import { SettingsApp } from '@renderer/settings/SettingsApp'

/**
 * 设置窗口的 slot 插件（MVP）。
 *
 * 注册的是现有 `SettingsApp`（具名导出）；设置树、页面、外观都不改。
 */
export const settingsPlugin = {
  name: 'nide-client-ui-settings',
  inject: ['slots'],
  apply(ctx: Context): void {
    const slots = slotsOf(ctx)
    ctx.effect(() => slots.register('settings.root', SettingsApp), 'settings.root')
    ctx.logger('client-ui-settings').info('settings.root registered')
  }
}
