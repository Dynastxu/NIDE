import type { NideContext } from '../../kernel/src/context.ts'
import { GIT_VIEWS } from './views.ts'

/**
 * 版本控制服务（`git` 域）。
 *
 * 现在只做一件事：把版本控制 / 提交两条内建视图登记到 `ctx.builtinViews`。
 * 视图组件在 `@nide/client-ui-git`，主窗口的 HostSlot 只按 id 找 slot —— 窗口包
 * 因此不需要知道 git 的任何组件。
 *
 * 真正的仓库操作（状态 / 暂存 / 提交 / 分支）以后加在这个包：它是 host 侧唯一持有
 * git 域实现的地方，通过 `git.*` RPC 暴露给渲染进程。
 */
export const gitService = {
  name: 'nide:service:git',
  inject: ['builtinViews'],

  apply(ctx: NideContext): void {
    for (const spec of GIT_VIEWS) {
      ctx.effect(() => ctx.builtinViews.register(spec), `builtin view ${spec.id}`)
    }
  }
}

/** profile 直接列这个模块；loader 取 default 作为插件对象 */
export default gitService
