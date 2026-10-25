import type { Context } from '@deepseek-ai/cordis'
import { slotsOf } from '@nide/client-ui-slots'
import App from '@renderer/App'

/**
 * 主窗口的 slot 插件（MVP）。
 *
 * 注册的是**现有的** `App`：布局、七分区、编辑器、编辑器标签都还在它里面，
 * 这一步只换「谁把它挂上去」，不改组件。
 *
 * TODO: 后续把 `WorkbenchLayout` / `ToolZone` / `EditorTabs` 拆成
 * `zone.*` / `editor.*` 子 slot。
 */
export const mainPlugin = {
  name: 'nide-client-ui-main',
  inject: ['slots'],
  apply(ctx: Context): void {
    const slots = slotsOf(ctx)
    ctx.effect(() => slots.register('main.root', App), 'main.root')
    ctx.logger('client-ui-main').info('main.root registered')
  }
}
