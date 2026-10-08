import fs from 'node:fs'
import path from 'node:path'
import { permissionManager } from './permission'
import { uiRegistry } from './ui-registry'
import type { PluginManifest, ViewLocation } from '@shared/plugin-api'

/** 视图入口的默认约定：插件目录下的 src/ui/index.tsx */
export const DEFAULT_VIEW_ENTRY = 'src/ui/index.tsx'

/** 合法的挂载位置（与渲染进程的 6 个工具区 + 主编辑区一一对应） */
const VALID_LOCATIONS: ReadonlySet<string> = new Set([
  'leftTop',
  'leftBottom',
  'rightTop',
  'rightBottom',
  'bottomLeft',
  'bottomRight',
  'main'
])

/** 旧契约 -> 新契约：老插件不用改 manifest 也能落在合理的位置 */
const LEGACY_LOCATIONS: Record<string, ViewLocation> = {
  sidebar: 'rightTop',
  panel: 'bottomLeft'
}

const FALLBACK_LOCATION: ViewLocation = 'rightTop'

/**
 * 把 manifest 里写的 location 归一化成合法的 ViewLocation。
 *
 * 渲染进程按 location 把视图塞进对应的工具区，一个不认识的值会让视图
 * 在任何区里都匹配不上 —— 表现为「插件加载了但界面上什么都看不到」，
 * 所以这里宁可回落到默认值并告警，也不把脏值透传给渲染进程。
 */
function normalizeLocation(raw: string | undefined, viewId: string): ViewLocation {
  const key = raw ?? FALLBACK_LOCATION

  if (VALID_LOCATIONS.has(key)) return key as ViewLocation

  const legacy = LEGACY_LOCATIONS[key]
  if (legacy) {
    console.warn(`[plugin-host] view ${viewId} 使用了旧 location "${key}"，已映射为 "${legacy}"`)
    return legacy
  }

  console.warn(
    `[plugin-host] view ${viewId} 的 location "${key}" 不合法，已回落到 "${FALLBACK_LOCATION}"`
  )
  return FALLBACK_LOCATION
}

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
        location: normalizeLocation(view.location, view.id),
        icon: view.icon,
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
