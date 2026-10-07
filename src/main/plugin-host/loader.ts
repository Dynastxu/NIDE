import fs from 'node:fs'
import path from 'node:path'
import { permissionManager } from './permission'
import { uiRegistry } from './ui-registry'
import type { PluginManifest } from '@shared/plugin-api'

/** 视图入口的默认约定：插件目录下的 src/ui/index.tsx */
export const DEFAULT_VIEW_ENTRY = 'src/ui/index.tsx'

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

export class PluginLoader {
  /**
   * 读取 manifest.json，注册权限与 UI 视图贡献点。
   *
   * 只做「发现 + 注册」，不启动插件后端子进程。
   * 后端沙箱留给后续阶段，且必须改成
   * 「子进程发 { id, method, params } -> 主进程 dispatch 执行 -> 回包」的形式，
   * 绝不能把带函数的 context 直接 postMessage 过去。
   */
  loadContributions(manifestPath: string): PluginManifest | null {
    let manifest: PluginManifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest
    } catch (err) {
      console.error(`[plugin-host] manifest 解析失败: ${manifestPath}`, err)
      return null
    }

    const pluginDir = path.dirname(manifestPath)
    const dir = path.basename(pluginDir)

    permissionManager.register(manifest.id, manifest.permissions ?? [])

    for (const view of manifest.contributes?.views ?? []) {
      const entryAbs = path.resolve(pluginDir, view.entry ?? DEFAULT_VIEW_ENTRY)
      // 关键：只传「插件目录内的相对路径」——不含盘符、不依赖 cwd，
      // dev 与打包后的取值完全一致。
      const entry = toPosix(path.relative(pluginDir, entryAbs))

      uiRegistry.register({
        id: view.id,
        title: view.title ?? view.id,
        location: view.location ?? 'sidebar',
        pluginId: manifest.id,
        dir,
        entry
      })

      console.log(`[plugin-host] view registered: ${view.id} -> plugins/builtin/${dir}/${entry}`)
    }

    return manifest
  }

  unload(pluginId: string): void {
    permissionManager.unregister(pluginId)
    uiRegistry.unregisterByPlugin(pluginId)
  }
}
