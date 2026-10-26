import type { Context } from '@deepseek-ai/cordis'
import { slotsOf } from '@nide/client-ui-slots'
import App from './App'

/**
 * 主窗口的 client 插件。
 *
 * 组件本体就在这个包里：`App`（启动编排）→ `MainApp`（窗口外观）→ 布局 / 七分区 /
 * 编辑器 / 文件树 / 内建视图（`HostSlot`）/ 文件菜单（`MainMenu`）。
 * 渲染进程的引导壳按窗口种类动态 import 这里的 `App`。
 *
 * 仍然是「一个根组件」：`zone.*` / `editor.*` 这些子 slot 的拆分是下一步的事，
 * 那一步只影响装配方式，不影响组件本身。
 */
export { default as App } from './App'
export { MainApp } from './MainApp'

export const mainPlugin = {
  name: 'nide-client-ui-main',
  inject: ['slots'],
  apply(ctx: Context): void {
    const slots = slotsOf(ctx)
    ctx.effect(() => slots.register('main.root', App), 'main.root')
    ctx.logger('client-ui-main').info('main.root registered')
  }
}
