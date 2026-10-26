import type { NideContext } from '../../../kernel/src/context.ts'
import type { HostProjectStore } from '../../project/src/host-project-store.ts'
import type {
  ProjectConfig,
  ProjectConfigUpdateResult
} from '../../../contracts/src/project/index.ts'
import {
  initializeProjectDirectory,
  loadProjectConfig,
  updateProjectConfig
} from './project-config.ts'

/**
 * 项目配置服务（`config.*`）。
 *
 * `read` / `update` 都针对**当前项目**（当前项目由 project 服务持有，这里不缓存）；
 * `initialize` 例外：它处理的是一个**刚新建**的目录，那时它还不是当前项目。
 *
 * 这个包同时充当「项目配置的纯函数库」（`loadProjectConfig` / `resolveConfigDirectory`
 * …），内容服务会直接 import 它 —— 那些函数没有状态，做成服务反而绕。
 */
export const configService = {
  name: 'nide:service:config',

  apply(ctx: NideContext): void {
    const currentRoot = (): string | undefined =>
      ctx.services.require<HostProjectStore>('project').getCurrent()?.path

    ctx.rpc.register('config', {
      read: async (): Promise<ProjectConfig | null> => {
        const root = currentRoot()
        if (!root) return null

        return loadProjectConfig(root)
      },

      update: async (patch): Promise<ProjectConfigUpdateResult | null> => {
        const root = currentRoot()
        if (!root) return null

        return updateProjectConfig(root, patch)
      },

      /**
       * 初始化一个**刚新建**的项目：默认配置、内容目录、默认角色图鉴与概述预设。
       *
       * 由 shell 在「新建项目」时经父端口调用（`invokeHost('config','initialize')`）：
       * 打开已有项目**不**走这里 —— 那会替用户建出他删过的东西。
       */
      initialize: async (root): Promise<ProjectConfig | null> => {
        const target = String(root ?? '')
        if (target.length === 0) return null

        return initializeProjectDirectory(target)
      }
    })
  }
}
