import { createElement } from 'react'
import type { Context } from 'cordis'
import { slotsOf } from '@nide/client-ui-slots'
import type { ZoneId } from '@nide/client-kit/stores/layout.store'
import { installDocuments } from '@nide/client-kit/stores/documents-cordis'
import App from './App'
import { ToolZone } from './layout/ToolZone'

/**
 * 主窗口的 client 插件。
 *
 * 组件本体是**窗口自己**的东西：`App`（启动编排）→ `MainApp`（窗口外观）→ 布局 /
 * 七分区 / 编辑器 / 文件菜单。文件树与条目动作已经搬到 `@nide/client-ui-explorer`，
 * 版本控制 / 提交在 `@nide/client-ui-git`；窗口只声明槽。
 *
 * **窗口根、六个工具区、`main.editor`、`shell.overlay` 都在这里声明**：它们画的都是
 * 主窗口自己的布局（`WorkbenchLayout` / `ToolZone`），没有第二处实现，也就不该有
 * 第二个包。之前那层 `client-ui-layout` 只是把同样的 `ToolZone` 包一层 slot，却要
 * 反向 import 主窗口的组件 —— 那是「包切错了轴」，不是一个可以长期存在的接缝。
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
    // workbench 的文档状态（打开 / 活跃 / 脏标记）对客户端功能包开放为 `ctx.documents`；
    // React 侧仍用 client-kit 的 `useDocumentsStore`。
    installDocuments(ctx)

    const slots = slotsOf(ctx)
    ctx.effect(() => slots.register('main.root', App), 'main.root')

    // 占位者就是 `ToolZone`：视图内容仍由它按布局 store 解析。哪天视图改由别的
    // 插件占据某个区，替换的是这里注册的组件，`WorkbenchLayout` 不用改。
    for (const id of ZONES) {
      const slot = `zone.${id}`
      ctx.effect(() => slots.register(slot, () => createElement(ToolZone, { id })), slot)
    }

    // 文件树由 `@nide/client-ui-explorer` 注册 `view.host.explorer`；
    // 版本控制 / 提交由 git 功能包注册；窗口只声明位置。
    slots.declare('main.editor', 'single')
    slots.declare('shell.overlay', 'list')

    ctx.logger('client-ui-main').info('main.root + zone slots registered', {
      zones: ZONES.length
    })
  }
}

/** 花名册协议：client-runtime 按 windowTypes 过滤后挂载这里列出的插件 */
export const clientPlugins = [mainPlugin]
