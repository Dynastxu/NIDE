import { createElement } from 'react'
import type { Context } from 'cordis'
import { slotsOf } from '@nide/client-ui-slots'
import type { ZoneId } from '@nide/client-kit/stores/layout.store'
import { installDocuments } from '@nide/client-kit/stores/documents-cordis'
import { HOST_EXPLORER_VIEW_ID, hostViewSlotName } from '@nide/contracts/plugin-api'
import App from './App'
import { ExplorerView } from './explorer/ExplorerView'
import { ToolZone } from './layout/ToolZone'

/**
 * 主窗口的 client 插件。
 *
 * 组件本体就在这个包里：`App`（启动编排）→ `MainApp`（窗口外观）→ 布局 / 七分区 /
 * 编辑器 / 文件树 / 文件菜单。
 *
 * **窗口根与六个工具区都在这里注册**：它们画的都是主窗口自己的布局
 * （`WorkbenchLayout` / `ToolZone`），没有第二处实现，也就不该有第二个包。
 * 之前那层 `client-ui-layout` 只是把同样的 `ToolZone` 包一层 slot，却要反向
 * import 主窗口的组件 —— 那是「包切错了轴」，不是一个可以长期存在的接缝。
 *
 * **具体视图不在这里**：文件树是主窗口自己的域，注册成 `view.host.explorer`；
 * 版本控制 / 提交由 `@nide/client-ui-git` 注册到同名约定的 slot。`HostSlot`
 * 只按 id 查 slot，所以加一个内建视图不需要改这个包。
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

    // 文件树是主窗口自己的内建视图；版本控制 / 提交由 git 功能包注册。
    const explorerSlot = hostViewSlotName(HOST_EXPLORER_VIEW_ID)
    ctx.effect(() => slots.register(explorerSlot, ExplorerView), explorerSlot)

    /**
     * Step 2：中间编辑区 / 窗口级浮层先声明成槽，但 occupant 仍由调用点的
     * fallback 渲染（旧组件），行为不变。等 editor / entry 各自成包后，
     * fallback 换成空，窗口不再 import 它们。
     */
    slots.declare('main.editor', 'single')
    slots.declare('shell.overlay', 'list')

    ctx.logger('client-ui-main').info('main.root + zone slots registered', {
      zones: ZONES.length,
      viewSlots: 1
    })
  }
}

/** 花名册协议：client-runtime 按 windowTypes 过滤后挂载这里列出的插件 */
export const clientPlugins = [mainPlugin]
