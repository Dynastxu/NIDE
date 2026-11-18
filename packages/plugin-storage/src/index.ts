import type { NideContext } from '../../kernel/src/context.ts'
import { PluginStorage } from './storage.ts'

/**
 * 插件存储服务（`plugin-storage`）。
 *
 * 每插件一个命名空间、同步视图 + 合并写盘。单独一个包是因为它**没有别的依赖**：
 * 清单服务只是它的调用方，后端进程通过 bootstrap 快照 / `storage:*` 协议用它。
 * 与清单 / 权限 / 后端放在同一个包里时，这 111 行的纯状态机被 3000 行淹没了。
 */
export const pluginStorageService = {
  name: 'nide:service:plugin-storage',
  inject: ['hostEnv'],

  apply(ctx: NideContext): void {
    ctx.provide('plugin-storage', new PluginStorage({ userDataDir: ctx.hostEnv.userDataDir }))
  }
}

/** profile 直接列这个模块；loader 取 default 作为插件对象 */
export default pluginStorageService
