import path from 'node:path'
import os from 'node:os'
import { CORE_PACKAGES, type CorePackage } from '../../../contracts/src/plugin-api/core-packages.ts'
import type { PermissionVariables } from '../../../contracts/src/plugin-api/permissions.ts'
import type { NideContext } from '../../../kernel/src/context.ts'
import type { HostProjectStore } from '../../project/src/host-project-store.ts'
import type { I18nService } from '../../i18n/src/index.ts'
import { builtinViews } from './builtin-views.ts'
import { pluginPreferencePath, PluginManager } from './plugins.ts'
import { PluginPermissionGuard } from './permissions.ts'
import { PluginBackendRuntime } from './backend/runtime.ts'
import type { TitleResolver } from './plugins.ts'

/**
 * 插件服务（`plugins.*`）。
 *
 * 插件目录的唯一读取方仍然在 host（清单 / 启停 / 贡献点），这一层只是把它包成
 * 一个服务：`ctx.rpc.register('plugins', …)` + `ctx.services.provide('plugins')`。
 *
 * 标题解析依赖 i18n 服务（语言包与当前语言都在那边）：
 * - 插件视图 / 设置页的 `%key%` → `i18n.host.resolveTitle(manifestNls, spec)`；
 * - 内建视图的 `host.*` → `i18n.host.message(key)`。
 *
 * 两条路都不能走错：前者认 `%`，后者认宿主词条表的 key（踩过，见 HANDOFF §8）。
 */
export const pluginsService = {
  name: 'nide:service:plugins',

  apply(ctx: NideContext): void {
    const manager = new PluginManager({
      builtinDir: path.join(ctx.env.appRoot, 'plugins', 'builtin'),
      thirdPartyDir: path.join(ctx.env.userDataDir, 'plugins'),
      preferencePath: pluginPreferencePath(ctx.env.userDataDir)
    })

    /**
     * 展示用的模块位置：**只给相对路径**。
     *
     * profile 行里是绝对路径（`{{NIDE_ROOT}}` 展开之后），直接回给渲染进程等于把
     * 用户的安装位置 / 账户名暴露到界面上 —— 发布版里那是隐私信息。这里换成相对
     * `appRoot` 的路径；跑出 appRoot（软链、外置插件目录）就退回一个稳定的包内路径，
     * 宁可少显示信息也不泄露路径。
     */
    const displayPath = (absolute: string, fallback: string): string => {
      if (!path.isAbsolute(absolute)) return absolute.split(path.sep).join('/')

      const relative = path.relative(ctx.env.appRoot, absolute)
      if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
        return fallback
      }

      return relative.split(path.sep).join('/')
    }

    const i18n = (): I18nService => ctx.services.require<I18nService>('i18n')

    /**
     * 「核心包」清单：设置里的插件页单独一栏展示。
     *
     * 宿主服务**从 profile 读**（加一个服务只改 profile，这里不用抄）；客户端平台包
     * 宿主看不到，来自 `CORE_PACKAGES` 静态表。它们都不可启停 —— 禁掉内核等于把
     * 应用关掉，所以只读展示。
     */
    const corePackages = (): CorePackage[] => {
      const services: CorePackage[] = ctx.env.profileRows
        .filter((row) => row.kind === 'service')
        .map((row) => ({
          id: row.id,
          name: row.id,
          kind: 'service',
          path: displayPath(row.name, `packages/services/${row.id}`),
          description: row.description ?? ''
        }))

      return [
        ...services,
        ...CORE_PACKAGES.map((entry) => ({ ...entry, kind: 'package' as const }))
      ]
    }

    const resolveTitle: TitleResolver = (pluginId, spec, fallback) =>
      i18n().host.resolveTitle(manager.manifestNls(pluginId), spec) || fallback

    /** 当前项目根：权限作用域里的 `${project}` 靠它展开 */
    const projectRoot = (): string | undefined =>
      ctx.services.require<HostProjectStore>('project').getCurrent()?.path

    /**
     * 权限作用域的展开变量。
     *
     * `pluginDir` 因插件而异，所以每次现取（`manager.locationOf`）；其余三样在一次
     * 启动里是常量。
     */
    const permissionVariables = (pluginId?: string): PermissionVariables => {
      const location = pluginId ? manager.locationOf(pluginId) : undefined
      return {
        ...(projectRoot() ? { project: projectRoot() } : {}),
        userData: ctx.env.userDataDir,
        temp: os.tmpdir(),
        home: ctx.env.home,
        ...(location ? { pluginDir: location.dirPath } : {})
      }
    }

    const permissionGuard = new PluginPermissionGuard({
      manager,
      variables: (pluginId) => permissionVariables(pluginId),
      projectRoot
    })

    /**
     * 插件后端（manifest.main）。
     *
     * 启停由本服务统一同步；宿主入口在服务装配完成后调 `startEnabled()`，
     * 并在退出时 `stopAll()`。测试只构造服务、不启动后端，所以不会 fork。
     */
    const backends = new PluginBackendRuntime({
      manager,
      permissions: permissionGuard,
      userDataDir: ctx.env.userDataDir,
      home: ctx.env.home
    })

    ctx.services.provide('plugins', manager)
    ctx.services.provide('plugin-permissions', permissionGuard)
    ctx.services.provide('plugin-backend', backends)

    /**
     * 后端方法的统一入口：`plugin.call(pluginId, method, params)`。
     *
     * 单独一个命名空间而不是塞进 `plugins`，是为了让「调用插件提供的能力」和
     * 「管理插件」分开；渲染进程（核心 UI 或插件）都走它。
     */
    ctx.rpc.register('plugin', {
      call: (pluginId, method, params) =>
        backends.invoke(String(pluginId ?? ''), String(method ?? ''), params)
    })

    ctx.rpc.register('plugins', {
      list: () => manager.list(),
      disabled: () => manager.disabled(),
      setEnabled: async (pluginId, enabled) => {
        const id = String(pluginId ?? '')
        manager.setEnabled(id, enabled === true)
        await backends.handleEnabled(id, enabled === true)
        return manager.disabled()
      },
      clientBundles: () => manager.clientBundles(),

      /** 插件后端的实时状态（启动中 / 运行中 / 失败 + 已注册方法） */
      backends: () => backends.status(),

      /**
       * 一个插件的声明 + 展开后的作用域。
       *
       * 详情页要显示「它能读哪些目录」；展开结果不能交给渲染进程自己算 ——
       * `${userData}` / `${project}` 的真实值属于宿主。插件不存在时返回 null。
       */
      permissions: (pluginId) => {
        const id = String(pluginId ?? '')
        const permissions = manager.permissionsOf(id)
        if (!permissions) return null

        return {
          pluginId: id,
          permissions,
          resolved: permissionGuard.snapshot(id)?.resolved ?? null
        }
      },

      /** 核心包（只读）：宿主服务 + 客户端平台包 */
      core: () => corePackages(),

      /** 视图表：内建视图（文件树 / 版本控制 / 提交）在前，插件视图在后，标题都已解析 */
      views: () => [
        ...builtinViews((key) => i18n().host.message(key)),
        ...manager.views(resolveTitle)
      ],

      /** 设置页，已滤掉被禁用插件的页，标题已解析 */
      settings: () => manager.settings(resolveTitle),

      install: async (sourceDir) => {
        const result = manager.install(String(sourceDir ?? ''))
        i18n().refresh()
        if (result.ok) await backends.reconcile()
        return result
      },
      remove: async (pluginId) => {
        const id = String(pluginId ?? '')
        // 先停后端再删目录：子进程可能正握着插件目录里的文件
        await backends.stop(id)
        const result = manager.remove(id)
        i18n().refresh()
        if (result.ok) await backends.reconcile()
        return result
      },

      /** 重新扫描目录（安装 / 卸载之后由 shell 调用） */
      rescan: async () => {
        manager.scan()
        i18n().refresh()
        await backends.reconcile()
        return manager.list()
      }
    })
  }
}

/** profile 通过 `kind: service` 行指向本文件，宿主入口取 default 后 apply */
export default pluginsService
