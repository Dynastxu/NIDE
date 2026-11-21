import type { Context } from 'cordis'
import { HOST_EXPLORER_VIEW_ID, hostViewSlotName } from '@nide/contracts/plugin-api'
import { slotsOf } from '@nide/client-ui-slots'
import { EntryActionHost } from './EntryActionHost'
import { ExplorerView } from './ExplorerView'

/**
 * 文件树功能包的 client 插件。
 *
 * 它负责两块界面：
 *
 * 1. 主窗口左上区的内建视图 `host.explorer`（`view.host.explorer` slot）；
 * 2. 窗口级 list 槽 `shell.overlay` 上的条目动作浮层（新建 / 重命名 / 删除的输入框与
 *    失败提示）。浮层必须挂在窗口顶层，不能跟着文件树面板一起卸载。
 *
 * 窗口包不需要 import 这里的任何组件：主窗口声明槽，功能包注册 occupant。
 * 文档状态来自 `@nide/client-kit/stores/documents.store`（打开 / 活跃 / 改名 / 删除子树），
 * 与 editor 共用同一份，不互相 import store。
 */
export const explorerPlugin = {
  name: 'nide-client-ui-explorer',
  inject: ['slots'],

  apply(ctx: Context): void {
    const slots = slotsOf(ctx)

    const viewSlot = hostViewSlotName(HOST_EXPLORER_VIEW_ID)
    ctx.effect(() => slots.register(viewSlot, ExplorerView), viewSlot)

    ctx.effect(
      () => slots.register({ name: 'shell.overlay', order: 0 }, EntryActionHost),
      'shell.overlay'
    )

    ctx.logger('client-ui-explorer').info('explorer view + entry overlay registered')
  }
}

/** 花名册协议：client-runtime 按 windowTypes 过滤后挂载这里列出的插件 */
export const clientPlugins = [explorerPlugin]
