import { emptyPluginContributions, type PluginContributions } from '@shared/plugin-api'
import { invokeHost } from '../host/process'
import { languagePackRegistry } from '../i18n'
import { manifestNlsRegistry } from '../i18n/manifest-nls'
import { loggerFor } from '../logger'
import { settingsRegistry } from './settings-registry'
import { uiRegistry } from './ui-registry'

/**
 * 插件贡献点在 shell 侧的**缓存**。
 *
 * 读盘的那一半已经在 host（[plugin-contributions.ts](../../packages/host/src/services/plugin-contributions.ts)）：
 * 扫两个插件目录、读 manifest、读语言包与 `package.nls*.json`，最后把纯数据下发。
 * 这里只做两件事：
 *
 * 1. 启动时拉一次，灌进下面几个注册表；
 * 2. 安装 / 卸载之后重拉一次（`rescanPluginHost`）。
 *
 * 为什么还留着这几个注册表而不是每次查询都隔着进程问：标题的 `%key%` 要用**当前
 * 语言**解析，而语言属于 shell 的 i18n（`src/main/i18n`）。视图列表、设置树、词条表
 * 都是同步查询的，把这份数据缓存住比每次查询都发一次 RPC 简单得多。
 */

const logger = loggerFor('plugin-host')

async function fetchContributions(): Promise<PluginContributions> {
  try {
    return await invokeHost<PluginContributions>('plugins', 'contributions')
  } catch (error) {
    /**
     * host 不可达时退回「什么都没有」：界面只剩内建视图，语言只剩中文基础表。
     * 这不是正常状态，但比让启动整个失败要好 —— 用户至少还能看到窗口和错误日志。
     */
    logger.error('Failed to read plugin contributions through host', { error })
    return emptyPluginContributions()
  }
}

/**
 * 把一份贡献点灌进注册表。
 *
 * **先清空再灌**：安装 / 卸载之后重扫时，上一轮注册的视图 / 设置页 / 语言包不该
 * 留在表里。清空是必须的 —— 注册表是同名覆盖，只灌不清会让被卸载插件的视图
 * 永远留在界面上。
 */
export function applyPluginContributions(contributions: PluginContributions): void {
  uiRegistry.reset()
  settingsRegistry.reset()
  languagePackRegistry.reset()
  manifestNlsRegistry.reset()

  for (const view of contributions.views) uiRegistry.register(view)
  for (const page of contributions.settings) settingsRegistry.register(page)
  for (const pack of contributions.locales) languagePackRegistry.register(pack)
  for (const [pluginId, tables] of Object.entries(contributions.manifestNls)) {
    manifestNlsRegistry.register(pluginId, tables)
  }
}

/**
 * 初始化插件宿主：从 host 拉一次贡献点。
 *
 * **必须在 `initI18n()` 之前完成** —— 语言包是随贡献点一起下发的，注册表空着的话
 * 所有 locale 都会回落成中文。
 *
 * 这个函数不抛：host 起不来时降级成空集合（日志里有原因），启动照常往下走。
 */
export async function initPluginHost(): Promise<void> {
  applyPluginContributions(await fetchContributions())

  logger.info('Plugin host initialization completed', {
    views: uiRegistry.getAll().length,
    settingsPages: settingsRegistry.getAll().length,
    languagePacks: languagePackRegistry.getAll().length
  })
}

/**
 * 重新拉一次贡献点（安装 / 卸载插件之后由 IPC 层调用）。
 *
 * host 在 install / remove 里已经重扫过目录，这里只是把 shell 的缓存换掉 ——
 * 不再有「两个加载器各扫一遍」的问题。
 *
 * i18n 的词条表是 `initI18n()` 时构建并缓存的，换掉语言包注册表不会重建它 ——
 * 带语言包的插件安装 / 卸载后仍要重启才完全生效，界面按 `requiresRestart` 提示。
 */
export async function rescanPluginHost(): Promise<void> {
  applyPluginContributions(await fetchContributions())
}
