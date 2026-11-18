import { createElement } from 'react'
import type { Context } from 'cordis'
import { slotsOf } from '@nide/client-ui-slots'
import type { ZoneId } from '@nide/client-kit/stores/layout.store'
import App from './App'
import { ToolZone } from './layout/ToolZone'

/**
 * 主窗口的 client 插件。
 *
 * 组件本体就在这个包里：`App`（启动编排）→ `MainApp`（窗口外观）→ 布局 / 七分区 /
 * 编辑器 / 文件树 / 内建视图（`HostSlot`）/ 文件菜单（`MainMenu`）。
 * 渲染进程的引导壳按窗口种类动态 import 这里的 `App`。
 *
 * **窗口根与六个工具区都在这里注册**：它们画的都是主窗口自己的布局
 * （`WorkbenchLayout` / `ToolZone`），没有第二处实现，也就不该有第二个包。
 * 之前那层 `client-ui-layout` 只是把同样的 `ToolZone` 包一层 slot，却要反向
 * import 主窗口的组件 —— 那是「包切错了轴」，不是一个可以长期存在的接缝。
 */
export { default as App } from './App'
export { MainApp } from './MainApp'

/** 六个工具区（`WorkbenchLayout` 按位置渲染 `<Slot name="zone.*">`） */
const ZONES: readonly ZoneId[] = [
  'leftTop',
  'leftBottom',
  'rightTop',
  'rightBottom',
  'bottomLeft',
  'bottomRight'
]

export const mainPlugin = {
  name: 'nide-client-ui-main',
  inject: ['slots'],
  apply(ctx: Context): void {
    const slots = slotsOf(ctx)
    ctx.effect(() => slots.register('main.root', App), 'main.root')

    // 占位者就是 `ToolZone`：视图内容仍由它按布局 store 解析。哪天视图改由别的
    // 插件占据某个区，替换的是这里注册的组件，`WorkbenchLayout` 不用改。
    for (const id of ZONES) {
      const slot = `zone.${id}`
      ctx.effect(() => slots.register(slot, () => createElement(ToolZone, { id })), slot)
    }

    ctx.logger('client-ui-main').info('main.root + zone slots registered', {
      zones: ZONES.length
    })
  }
}

/** 花名册协议：client-runtime 按 windowTypes 过滤后挂载这里列出的插件 */
export const clientPlugins = [mainPlugin]
