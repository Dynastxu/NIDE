import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { uiRegistry } from './ui-registry'
import { settingsRegistry } from './settings-registry'
import { pluginRegistry } from './plugin-registry'
import { PluginLoader } from './loader'
import { languagePackRegistry } from '../i18n'
import { loggerFor } from '../logger'
import type { LocaleSourceTier } from '@shared/i18n'

/**
 * 本模块的日志出口。
 *
 * 加载器那份可以在测试里替换（见 loader.ts 的 setPluginHostLogger），
 * 这里扫描目录时的告警不参与单元测试，用固定出口即可。
 */
const logger = loggerFor('plugin-host')

const BUILTIN_REL = path.join('plugins', 'builtin')

function resolveBuiltinPluginsDir(): string {
  // dev：app.getAppPath() = 项目根
  // 打包：app.getAppPath() = .../resources/app.asar（plugins/ 会被 electron-builder 打进 asar）
  const candidates = [
    path.join(app.getAppPath(), BUILTIN_REL),
    path.join(process.cwd(), BUILTIN_REL)
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0]
}

/**
 * 第三方插件目录：userData 下，用户可写。
 *
 * 放 userData 而不是安装目录，是因为安装目录在 macOS/Windows 上通常不可写、
 * 而且会被应用更新覆盖 —— 用户装的语言包不该因为升级宿主就没了。
 */
export function resolveThirdPartyPluginsDir(): string {
  return path.join(app.getPath('userData'), 'plugins')
}

function scanDir(loader: PluginLoader, dir: string, source: LocaleSourceTier): number {
  if (!fs.existsSync(dir)) return 0

  let loaded = 0
  for (const name of fs.readdirSync(dir)) {
    const manifestPath = path.join(dir, name, 'manifest.json')
    if (!fs.existsSync(manifestPath)) continue
    try {
      // loadContributions 返回 manifest 本身，顺手登记进插件清单 ——
      // 这样「设置 -> 插件」能列出**全部**插件，包括没有任何视图的语言包。
      // 从 uiRegistry 反推插件列表是不行的，那类插件会整个不可见。
      const manifest = loader.loadContributions(manifestPath, source)
      if (manifest) pluginRegistry.register(manifest, source, name, path.join(dir, name))
      loaded += 1
    } catch (err) {
      logger.error('Failed to load plugin', { name, error: err })
    }
  }
  return loaded
}

/**
 * 初始化插件宿主：扫描内置与第三方插件目录，注册权限、视图贡献点和语言包。
 *
 * 注意：这里不加载任何前端代码 —— 插件 UI 由渲染进程的 Vite 在构建期打包。
 * 主进程只负责回答「有哪些视图」「有哪些语言包」，不负责「怎么加载组件」。
 *
 * 两个目录的扫描顺序（内置在前、第三方在后）不影响语言包优先级 ——
 * 优先级由 tier 决定，不靠加载顺序，见 LanguagePackRegistry.buildMessages。
 */
/** 当前这一轮扫描用的 loader；rescan 时用它逐个 unload */
let activeLoader: PluginLoader | null = null

export function initPluginHost(): void {
  const loader = new PluginLoader()
  activeLoader = loader
  const builtinDir = resolveBuiltinPluginsDir()
  const thirdPartyDir = resolveThirdPartyPluginsDir()

  if (!fs.existsSync(builtinDir)) {
    logger.warn('Built-in plugin directory not found', { dir: builtinDir })
  } else {
    scanDir(loader, builtinDir, 'builtin')
  }

  const thirdPartyCount = scanDir(loader, thirdPartyDir, 'third-party')
  // 把路径打出来：第三方语言包要放哪儿，是用户最常问的问题
  logger.info('Plugin directories scanned', {
    thirdPartyDir,
    thirdPartyCount
  })

  logger.info('Plugin host initialization completed', {
    views: uiRegistry.getAll().length,
    settingsPages: settingsRegistry.getAll().length,
    languagePacks: languagePackRegistry.getAll().length
  })
}

/**
 * 重新扫描插件目录（安装 / 卸载之后由 IPC 层调用）。
 *
 * 先按插件 id 把上一轮注册的视图 / 设置页 / 语言包 / 权限全部撤掉，再重新扫描。
 * i18n 的词条表是 `initI18n()` 时构建并缓存的，重扫不会重建它 —— 带语言包的插件
 * 安装 / 卸载后仍要重启才完全生效，界面按 `requiresRestart` 提示用户。
 */
export function rescanPluginHost(): void {
  if (activeLoader) {
    for (const plugin of pluginRegistry.getAll()) activeLoader.unload(plugin.id)
  }

  pluginRegistry.clear()
  initPluginHost()
}
