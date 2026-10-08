import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { uiRegistry } from './ui-registry'
import { PluginLoader } from './loader'
import { languagePackRegistry } from '../i18n/language-packs'
import type { LocaleSourceTier } from '@shared/i18n'

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
      loader.loadContributions(manifestPath, source)
      loaded += 1
    } catch (err) {
      console.error(`[plugin-host] Failed to load plugin: ${name}`, err)
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
export function initPluginHost(): void {
  const loader = new PluginLoader()
  const builtinDir = resolveBuiltinPluginsDir()
  const thirdPartyDir = resolveThirdPartyPluginsDir()

  if (!fs.existsSync(builtinDir)) {
    console.warn(`[plugin-host] Built-in plugin directory not found: ${builtinDir}`)
  } else {
    scanDir(loader, builtinDir, 'builtin')
  }

  const thirdPartyCount = scanDir(loader, thirdPartyDir, 'third-party')
  // 把路径打出来：第三方语言包要放哪儿，是用户最常问的问题
  console.log(`[plugin-host] 第三方插件目录: ${thirdPartyDir}（已加载 ${thirdPartyCount} 个）`)

  console.log(
    `[plugin-host] View registration completed, registered ${uiRegistry.getAll().length} views, ` +
      `${languagePackRegistry.getAll().length} language packs`
  )
}
