import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {} from '@cordisjs/plugin-loader'
import { CORE_PACKAGES, type CorePackage } from '../../contracts/src/plugin-api/core-packages.ts'
import type { PermissionVariables } from '../../contracts/src/plugin-api/permissions.ts'
import type { NideContext } from '../../kernel/src/context.ts'
import type { I18nService } from '../../i18n/src/index.ts'
import { builtinViews } from './builtin-views.ts'
import { pluginPreferencePath, PluginManager } from './plugins.ts'
import { PluginPermissionGuard } from './permissions.ts'
import { PluginStorage } from './storage.ts'
import { PluginCapabilities } from './capabilities.ts'
import { PluginBackendRuntime } from './backend/runtime.ts'
import { runUninstallScript } from './backend/uninstall.ts'
import { removePluginRow, upsertPluginRow } from './profile-rows.ts'
import type { TitleResolver } from './plugins.ts'

/**
 * 插件服务（`plugins.*`）。
 *
 * 插件目录的唯一读取方仍然在 host（清单 / 启停 / 贡献点），这一层只是把它包成
 * 一组 Cordis 服务（`ctx.provide` + `declare module`）。
 *
 * 标题解析依赖 i18n 服务（语言包与当前语言都在那边）：
 * - 插件视图 / 设置页的 `%key%` → `i18n.host.resolveTitle(manifestNls, spec)`；
 * - 内建视图的 `host.*` → `i18n.host.message(key)`。
 *
 * i18n 反过来 `inject: ['plugins']`，所以这里**不能**注入它 —— 两边都等对方会
 * 互相 PENDING。取法改成调用时 `ctx.get('i18n')`（与改造前的懒加载一致）。
 *
 * 两条路都不能走错：前者认 `%`，后者认宿主词条表的 key（踩过，见 HANDOFF §8）。
 */
export const pluginsService = {
  name: 'nide:service:plugins',
  inject: ['project', 'rpc', 'hostEnv'],

  apply(ctx: NideContext): void {
    const manager = new PluginManager({
      // 内置插件是组合行（包自己 `registerPackage`），目录扫描不再承担发现职责；
      // 用户安装的插件暂时仍从 `<userData>/plugins` 扫描。
      builtinDir: [],
      thirdPartyDir: path.join(ctx.hostEnv.userDataDir, 'plugins'),
      preferencePath: pluginPreferencePath(ctx.hostEnv.userDataDir)
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

      const relative = path.relative(ctx.hostEnv.appRoot, absolute)
      if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
        return fallback
      }

      return relative.split(path.sep).join('/')
    }

    const i18n = (): I18nService => {
      const service = ctx.get('i18n')
      if (!service) throw new Error('i18n service is not available')
      return service
    }

    /** loader 按需取：注入它会让「只想跑服务、不挂 loader」的测试全部 PENDING */
    const loader = (): NonNullable<ReturnType<NideContext['get']>> => {
      const value = ctx.get('loader')
      if (!value) throw new Error('loader service is not available')
      return value
    }

    /** 安装式插件的行入口（编译产物里是 .js，源码树里是 .ts） */
    const shimSpecifier = (): string => {
      const here = path.dirname(fileURLToPath(import.meta.url))
      for (const name of ['plugin-shim.js', 'plugin-shim.ts']) {
        const candidate = path.resolve(here, '../../../host/src', name)
        if (fs.existsSync(candidate)) return pathToFileURL(candidate).href
      }
      throw new Error(`plugin shim entry not found next to ${here}`)
    }

    /** 让 loader 按「一行」挂载刚装好的插件（不再依赖目录扫描） */
    const mountRow = async (dir: string): Promise<void> => {
      const entryId = await loader().create({ name: shimSpecifier(), config: { dir } })
      const entry = loader().resolve(entryId)
      if (entry.fiber) await entry.fiber
    }

    /** 找出某个插件目录对应的 loader 条目（重装 / 卸载用） */
    const rowEntryId = (dir: string): string | null => {
      for (const entry of loader().entries()) {
        const config = entry.options.config as { dir?: unknown } | undefined
        if (config?.dir === dir) return entry.id
      }
      return null
    }

    const unmountRow = async (dir: string): Promise<void> => {
      const entryId = rowEntryId(dir)
      if (!entryId) return
      loader().remove(entryId)
      await loader().await()
    }

    /**
     * 「核心包」清单：设置里的插件页单独一栏展示。
     *
     * 核心行由 profile 的 `core: true` 标记（加一个服务只改 profile，这里不用抄）；
     * 客户端平台包宿主看不到，来自 `CORE_PACKAGES` 静态表。它们都不可启停 ——
     * 禁掉内核等于把应用关掉，所以只读展示。
     */
    const corePackages = (): CorePackage[] => {
      const services: CorePackage[] = ctx.hostEnv.profileRows
        .filter((row) => row.core === true)
        .map((row) => ({
          id: row.id,
          name: row.id,
          kind: 'service',
          path: displayPath(
            row.name,
            row.id === 'plugins' ? 'packages/plugin-runtime' : `packages/${row.id}`
          ),
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
    const projectRoot = (): string | undefined => ctx.project.getCurrent()?.path

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
        userData: ctx.hostEnv.userDataDir,
        temp: os.tmpdir(),
        home: ctx.hostEnv.home,
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
    const storage = new PluginStorage({ userDataDir: ctx.hostEnv.userDataDir })
    const capabilities = new PluginCapabilities({ manager })

    const backends = new PluginBackendRuntime({
      manager,
      permissions: permissionGuard,
      storage,
      capabilities,
      userDataDir: ctx.hostEnv.userDataDir,
      home: ctx.hostEnv.home
    })

    ctx.provide('plugins', manager)
    ctx.provide('plugin-permissions', permissionGuard)
    ctx.provide('plugin-storage', storage)
    ctx.provide('plugin-capabilities', capabilities)
    ctx.provide('plugin-backend', backends)

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

      /** 显式激活一个后端（`onView` / `onCommand` 之外的入口；也可给 Agent 用） */
      activate: async (pluginId) => {
        await backends.ensure(String(pluginId ?? ''))
        return backends.status()
      },

      /**
       * 渲染进程打开一个视图时调用：`onView:<viewId>` 的插件后端在这里激活。
       *
       * 视图 → 插件 的归属只有清单知道（`manager.viewOwner`），所以放在宿主判。
       */
      activateView: async (viewId) => {
        await backends.activateForView(String(viewId ?? ''))
        return backends.status()
      },

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
        if (!result.ok) return result

        const id = result.plugin.id
        const location = manager.locationOf(id)
        if (!location) return { ok: false, reason: 'unreadable' as const }

        /**
         * 安装 = 目录 + 一行。行写进 profile patch（这是 DSH 的装配点），
         * 再让 loader 按行挂载 —— 失败就把三样一起回滚，不留半成品。
         */
        try {
          upsertPluginRow(ctx.hostEnv.profileDir, id, location.dirPath)
          await mountRow(location.dirPath)
        } catch (error) {
          console.warn('[nide-host] failed to mount the installed plugin row', {
            pluginId: id,
            error
          })
          removePluginRow(ctx.hostEnv.profileDir, id)
          manager.remove(id)
          return { ok: false, reason: 'unreadable' as const }
        }

        i18n().refresh()
        await backends.reconcile()
        return result
      },
      remove: async (pluginId) => {
        const id = String(pluginId ?? '')
        // 先停后端再删目录：子进程可能正握着插件目录里的文件
        await backends.stop(id)
        // 停用会 flush 一次；这里再显式落一次，确保卸载脚本读到最新快照
        storage.flush(id)

        /**
         * 卸载脚本在插件停用之后、目录删除之前跑：它清理的是插件在目录外留下的
         * 东西（下载的文件、实例目录…）。脚本失败时**不删目录** —— 让用户能看到
         * 错误并重试，比留下一个清不干净的半成品好。
         */
        if (manager.uninstallEntryOf(id)) {
          try {
            await runUninstallScript({
              manager,
              permissions: permissionGuard,
              pluginId: id,
              userDataDir: ctx.hostEnv.userDataDir,
              home: ctx.hostEnv.home,
              log: (level, message) => console[level](`[plugin:${id}] ${message}`)
            })
          } catch (error) {
            console.warn('[nide-host] plugin uninstall script failed', { pluginId: id, error })
            return { ok: false, reason: 'uninstall-failed' as const }
          }
        }

        // 先卸行、再删目录：行是装配真相，必须和目录一起消失
        const location = manager.locationOf(id)
        if (location) await unmountRow(location.dirPath)
        removePluginRow(ctx.hostEnv.profileDir, id)

        const result = manager.remove(id)
        i18n().refresh()
        if (result.ok) {
          storage.remove(id)
          await backends.reconcile()
        }
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

/** profile 直接列这个模块；loader 取 default 作为插件对象 */
export default pluginsService
