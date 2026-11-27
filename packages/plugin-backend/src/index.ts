import type { NideContext } from '@nide/kernel/context.ts'
import { PluginBackendRuntime } from './runtime.ts'

/**
 * 插件后端子进程服务（`plugin-backend`）。
 *
 * `manifest.main` 指向的插件代码在独立子进程里跑（`sandboxed` 由 Node 的
 * `--permission` 强制），本服务负责 fork / 握手 / 调用 / 起停 / 崩溃隔离；
 * 卸载脚本也走同一套机制（`uninstall()`）。它是插件子系统里**唯一**碰进程边界
 * 的地方，所以单独成包。
 */
export const pluginBackendService = {
  name: 'nide:service:plugin-backend',
  inject: ['plugins', 'plugin-permissions', 'plugin-storage', 'plugin-capabilities', 'hostEnv'],

  apply(ctx: NideContext): void {
    ctx.provide(
      'plugin-backend',
      new PluginBackendRuntime({
        manager: ctx.plugins,
        permissions: ctx['plugin-permissions'],
        storage: ctx['plugin-storage'],
        capabilities: ctx['plugin-capabilities'],
        userDataDir: ctx.hostEnv.userDataDir,
        home: ctx.hostEnv.home
      })
    )
  }
}

/** profile 直接列这个模块；loader 取 default 作为插件对象 */
export default pluginBackendService
