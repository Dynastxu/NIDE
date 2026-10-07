import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { uiRegistry } from './ui-registry'
import { PluginLoader } from './loader'

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
 * 初始化插件宿主：扫描内置插件目录，注册权限与视图贡献点。
 *
 * 注意：这里不加载任何前端代码 —— 插件 UI 由渲染进程的 Vite 在构建期打包。
 * 主进程只负责回答「有哪些视图」，不负责「怎么加载组件」。
 */
export function initPluginHost(): void {
  const builtinDir = resolveBuiltinPluginsDir()

  if (!fs.existsSync(builtinDir)) {
    console.warn(`[plugin-host] 未找到内置插件目录: ${builtinDir}`)
    return
  }

  const loader = new PluginLoader()
  for (const name of fs.readdirSync(builtinDir)) {
    const manifestPath = path.join(builtinDir, name, 'manifest.json')
    if (!fs.existsSync(manifestPath)) continue
    try {
      loader.loadContributions(manifestPath)
    } catch (err) {
      console.error(`[plugin-host] 加载插件失败: ${name}`, err)
    }
  }

  console.log(`[plugin-host] 视图注册完成，共 ${uiRegistry.getAll().length} 个`)
}
