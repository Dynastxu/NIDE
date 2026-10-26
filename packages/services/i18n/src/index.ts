import type { NideContext } from '../../../kernel/src/context.ts'
import type { PluginManager } from '../../plugins/src/plugins.ts'
import { HostI18n } from './i18n.ts'

/**
 * 本地化服务（`i18n.*`）。
 *
 * 语言包来自插件（`plugins.contributions().locales`），所以「灌语言包」这件事
 * 只能由两者配合完成：这个服务提供 `refresh()`，插件服务在安装 / 卸载 / 重扫之后
 * 调用它；`init` / `setLocale` 也会先 refresh 一次（保证首次启动拿到最新集合）。
 *
 * 提供出去的是一个**小接口**而不是 `HostI18n` 本身：别人需要的是「刷新语言包」与
 * 「解析标题 / 取词条」，不该顺手改掉语言偏好。
 */
export interface I18nService {
  /** 从插件目录重新灌一遍语言包（安装 / 卸载之后必须调） */
  refresh(): void
  host: HostI18n
}

export const i18nService = {
  name: 'nide:service:i18n',

  apply(ctx: NideContext): void {
    const host = new HostI18n({ userDataDir: ctx.env.userDataDir })

    const service: I18nService = {
      refresh: () => {
        const plugins = ctx.services.require<PluginManager>('plugins')
        host.setPacks(plugins.contributions().locales)
      },
      host
    }

    ctx.services.provide('i18n', service)

    ctx.rpc.register('i18n', {
      init: (request) => {
        service.refresh()
        const system = (request as { system?: unknown } | undefined)?.system
        return host.init(Array.isArray(system) ? system.map((tag) => String(tag)) : [])
      },
      setLocale: (locale) => {
        service.refresh()
        return host.setLocale(String(locale ?? ''))
      },
      payload: () => host.payload()
    })
  }
}
