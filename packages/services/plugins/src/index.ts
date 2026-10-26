import path from 'node:path'
import { CORE_PACKAGES, type CorePackage } from '../../../contracts/src/plugin-api/core-packages.ts'
import type { NideContext } from '../../../kernel/src/context.ts'
import type { I18nService } from '../../i18n/src/index.ts'
import { builtinViews } from './builtin-views.ts'
import { PluginManager, pluginPreferencePath } from './plugins.ts'
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
          path: row.name,
          description: row.description ?? ''
        }))

      return [
        ...services,
        ...CORE_PACKAGES.map((entry) => ({ ...entry, kind: 'package' as const }))
      ]
    }

    const resolveTitle: TitleResolver = (pluginId, spec, fallback) =>
      i18n().host.resolveTitle(manager.manifestNls(pluginId), spec) || fallback

    ctx.services.provide('plugins', manager)

    ctx.rpc.register('plugins', {
      list: () => manager.list(),
      disabled: () => manager.disabled(),
      setEnabled: (pluginId, enabled) => {
        manager.setEnabled(String(pluginId ?? ''), enabled === true)
        return manager.disabled()
      },
      clientBundles: () => manager.clientBundles(),

      /** 核心包（只读）：宿主服务 + 客户端平台包 */
      core: () => corePackages(),

      /** 视图表：内建视图（文件树 / 版本控制 / 提交）在前，插件视图在后，标题都已解析 */
      views: () => [
        ...builtinViews((key) => i18n().host.message(key)),
        ...manager.views(resolveTitle)
      ],

      /** 设置页，已滤掉被禁用插件的页，标题已解析 */
      settings: () => manager.settings(resolveTitle),

      install: (sourceDir) => {
        const result = manager.install(String(sourceDir ?? ''))
        i18n().refresh()
        return result
      },
      remove: (pluginId) => {
        const result = manager.remove(String(pluginId ?? ''))
        i18n().refresh()
        return result
      },

      /** 重新扫描目录（安装 / 卸载之后由 shell 调用） */
      rescan: () => {
        manager.scan()
        i18n().refresh()
        return manager.list()
      }
    })
  }
}

/** profile 通过 `kind: service` 行指向本文件，宿主入口取 default 后 apply */
export default pluginsService
