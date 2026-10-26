import type { Context } from '@deepseek-ai/cordis'
import { slotsOf } from '@nide/client-ui-slots'
import WelcomeApp from './WelcomeApp'

/**
 * 欢迎窗口的 client 插件。
 *
 * 组件本体就在这个包里（`WelcomeApp` / `ProjectsPanel` / `SettingsButton`）——
 * 此前它只是把渲染进程里的窗口组件包一层 slot。窗口种类与挂载点
 * 仍然由渲染进程的引导壳决定（`ROOTS.welcome` 也 import 这里的组件）。
 */
export { default as WelcomeApp } from './WelcomeApp'
export { ProjectsPanel } from './ProjectsPanel'
export { SettingsButton } from './SettingsButton'

export const welcomePlugin = {
  name: 'nide-client-ui-welcome',
  inject: ['slots'],
  apply(ctx: Context): void {
    const slots = slotsOf(ctx)
    ctx.effect(() => slots.register('welcome.root', WelcomeApp), 'welcome.root')
    ctx.logger('client-ui-welcome').info('welcome.root registered')
  }
}
