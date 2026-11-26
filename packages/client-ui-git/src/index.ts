import type { Context } from 'cordis'
import { HOST_COMMIT_VIEW_ID, HOST_GIT_VIEW_ID, hostViewSlotName } from '@nide/contracts/plugin-api'
import { slotsOf } from '@nide/client-ui-slots'
import { CommitView } from './CommitView'
import { GitView } from './GitView'

export { CommitView } from './CommitView'
export { GitView } from './GitView'

/**
 * 版本控制功能包的 client 插件。
 *
 * 它只做一件事：把两个视图组件注册到宿主约定的 slot 上。窗口包不需要 import
 * 这些组件，也不需要知道 git 有几个视图 —— 主窗口的 `HostSlot` 按视图 id 去
 * `hostViewSlotName(id)` 里查，查不到才显示「未实现」。
 *
 * 挂载点来自 package.json 的 `nide.client.windowTypes`（主窗口），由
 * `client-runtime` 的花名册装配；不是任何窗口的静态 import。
 */
export const gitPlugin = {
  name: 'nide-client-ui-git',
  inject: ['slots'],

  apply(ctx: Context): void {
    const slots = slotsOf(ctx)

    for (const [viewId, Component] of [
      [HOST_GIT_VIEW_ID, GitView],
      [HOST_COMMIT_VIEW_ID, CommitView]
    ] as const) {
      const slot = hostViewSlotName(viewId)
      ctx.effect(() => slots.register(slot, Component), slot)
    }

    ctx.logger('client-ui-git').info('version control view slots registered', {
      views: 2
    })
  }
}

/** 花名册协议：client-runtime 按 windowTypes 过滤后挂载这里列出的插件 */
export const clientPlugins = [gitPlugin]
