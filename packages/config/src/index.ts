import type { NideContext } from '../../kernel/src/context.ts'
import type {
  GalleryRegistry,
  GalleryRegistryUpdateResult,
  ProjectConfig,
  ProjectConfigPatch,
  ProjectConfigUpdateResult
} from '../../contracts/src/project/index.ts'
import {
  initializeProjectDirectory,
  loadGalleryRegistry,
  loadProjectConfig,
  remapOverviewRole,
  resolveConfigDirectory,
  updateGalleryRegistry,
  updateProjectConfig
} from './project-config.ts'

/**
 * 项目配置服务（`config.*`）。
 *
 * **它是 `.nide/config.yml` 与图鉴注册表的唯一实现**：读、写、初始化，以及配置里
 * 那些相对路径的解析。其他服务（内容服务）用 `inject: ['config']` 拿 `ctx.config`
 * 调用它 —— 不再 import 这个包的实现文件。
 *
 * 方法分两类：
 * - 针对**当前项目**的（`read` / `updateCurrent`）：项目由 project 服务持有，
 *   这里不缓存，切项目之后不需要通知任何人；
 * - 针对**显式 root** 的（`load` / `update` / `loadGalleryRegistry` / …）：
 *   内容服务的调用都带一个它已经校验过的根，配置不该再去猜是哪个项目。
 *
 * 当前项目通过 `inject: ['project']`（`ctx.project`）取。
 */
export interface ConfigService {
  /** 当前项目的配置；没有打开的项目时 null */
  read(): Promise<ProjectConfig | null>
  /** 更新当前项目的配置；没有打开的项目时 null */
  updateCurrent(patch: ProjectConfigPatch): Promise<ProjectConfigUpdateResult | null>
  /** 初始化一个刚新建的项目目录（默认配置、内容目录、预设），返回解析后的配置 */
  initialize(root: string): Promise<ProjectConfig | null>
  /** 读任意 root 的配置（内容服务校验过根之后用） */
  load(root: string): Promise<ProjectConfig>
  /** 更新任意 root 的配置 */
  update(root: string, patch: ProjectConfigPatch): Promise<ProjectConfigUpdateResult>
  /** 配置里某个相对目录的绝对路径 */
  directory(root: string, relative: string): string
  loadGalleryRegistry(root: string): Promise<GalleryRegistry>
  updateGalleryRegistry(root: string, characters: string): Promise<GalleryRegistryUpdateResult>
  /** 概述里的大纲 / 写作风格按文件名记在配置里：改名之后要把那条映射跟上 */
  remapOverviewRole(root: string, previousPath: string, nextPath: string): Promise<boolean>
}

export const configService = {
  name: 'nide:service:config',
  inject: ['project', 'rpc', 'hostEnv'],

  apply(ctx: NideContext): void {
    const currentRoot = (): string | undefined => ctx.project.getCurrent()?.path

    const service: ConfigService = {
      read: async () => {
        const root = currentRoot()
        return root ? loadProjectConfig(root) : null
      },

      updateCurrent: async (patch) => {
        const root = currentRoot()
        return root ? updateProjectConfig(root, patch) : null
      },

      /**
       * 初始化一个**刚新建**的项目：默认配置、内容目录、默认角色图鉴与概述预设。
       *
       * 由 shell 在「新建项目」时经父端口调用（`invokeHost('config','initialize')`）：
       * 打开已有项目**不**走这里 —— 那会替用户建出他删过的东西。
       */
      initialize: async (root) => {
        const target = String(root ?? '')
        if (target.length === 0) return null

        return initializeProjectDirectory(target)
      },

      load: (root) => loadProjectConfig(root),
      update: (root, patch) => updateProjectConfig(root, patch),
      directory: (root, relative) => resolveConfigDirectory(root, relative),
      loadGalleryRegistry: (root) => loadGalleryRegistry(root),
      updateGalleryRegistry: (root, characters) => updateGalleryRegistry(root, characters),
      remapOverviewRole: (root, previousPath, nextPath) =>
        remapOverviewRole(root, previousPath, nextPath)
    }

    ctx.provide('config', service)

    ctx.rpc.register('config', {
      read: () => service.read(),
      update: (patch) => service.updateCurrent(patch as ProjectConfigPatch),
      initialize: (root) => service.initialize(String(root ?? ''))
    })
  }
}

/** profile 直接列这个模块；loader 取 default 作为插件对象 */
export default configService
