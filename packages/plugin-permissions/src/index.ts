import os from 'node:os'
import type { NideContext } from '@nide/kernel/context.ts'
import type { PermissionVariables } from '@nide/contracts/plugin-api/permissions.ts'
import { PluginPermissionGuard } from './permissions.ts'

/**
 * 插件权限服务（`plugin-permissions`）。
 *
 * 它是 RPC 分发的准入检查（`RpcRegistry.setAuthorizer` 的实现），也是插件后端
 * 沙箱参数的**唯一**权限来源。单独一个包：被执行的是「声明 → 展开 → 判定」这套
 * 纯逻辑，和清单 / 安装 / 子进程没有关系。
 *
 * 作用域变量每次现取（项目根、userData、插件目录都可能变），所以这里只持有取值
 * 函数，不缓存结果。
 */
export const pluginPermissionsService = {
  name: 'nide:service:plugin-permissions',
  inject: ['plugins', 'project', 'hostEnv'],

  apply(ctx: NideContext): void {
    /** 当前项目根：权限作用域里的 `${project}` 靠它展开 */
    const projectRoot = (): string | undefined => ctx.project.getCurrent()?.path

    /**
     * 权限作用域的展开变量。
     *
     * `pluginDir` 因插件而异，所以每次现取（`manager.locationOf`）；其余几样在一次
     * 启动里是常量。
     */
    const variables = (pluginId?: string): PermissionVariables => {
      const location = pluginId ? ctx.plugins.locationOf(pluginId) : undefined
      return {
        ...(projectRoot() ? { project: projectRoot() } : {}),
        userData: ctx.hostEnv.userDataDir,
        temp: os.tmpdir(),
        home: ctx.hostEnv.home,
        ...(location ? { pluginDir: location.dirPath } : {})
      }
    }

    ctx.provide(
      'plugin-permissions',
      new PluginPermissionGuard({
        manager: ctx.plugins,
        variables,
        projectRoot
      })
    )
  }
}

/** profile 直接列这个模块；loader 取 default 作为插件对象 */
export default pluginPermissionsService
