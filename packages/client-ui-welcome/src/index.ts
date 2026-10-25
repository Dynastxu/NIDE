import type { Context } from '@deepseek-ai/cordis'
import { slotsOf } from '@nide/client-ui-slots'
import WelcomeApp from '@renderer/welcome/WelcomeApp'

/**
 * 欢迎窗口的 slot 插件（MVP）。
 *
 * 这一版只是把**现有的** `WelcomeApp` 注册到 `welcome.root`，不改它的任何一行；
 * 等 slot 链路稳定后，再把组件真正搬进这个包。
 */
export const welcomePlugin = {
  name: 'nide-client-ui-welcome',
  inject: ['slots'],
  apply(ctx: Context): void {
    const slots = slotsOf(ctx)
    ctx.effect(() => slots.register('welcome.root', WelcomeApp), 'welcome.root')
    ctx.logger('client-ui-welcome').info('welcome.root registered')
  }
}
