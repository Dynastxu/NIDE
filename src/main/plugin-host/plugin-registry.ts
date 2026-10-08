import type { LocaleSourceTier } from '@shared/i18n'
import type { PluginManifest } from '@shared/plugin-api'

/**
 * 插件清单注册表：**已发现**的插件（不只是有 UI 视图的那些）。
 *
 * 为什么需要它：uiRegistry 只认得「注册了视图的插件」，而「设置 -> 插件」要列出
 * 全部插件 —— 包括纯数据插件（语言包就是这样，它没有任何视图）。拿 uiRegistry
 * 去反推插件列表，这类插件会整个不可见。
 *
 * 这里同样**只存纯数据**：没有函数、没有模块引用、没有绝对路径。
 * 和视图注册表一个道理 —— 主进程不掌握任何「怎么加载插件」的知识。
 *
 * 视图是**复制**一份存进来的，不是引用 uiRegistry。视图注册表会因为
 * unregisterByPlugin 被改动，清单跟着变的话，「这个插件提供过哪些视图」
 * 这种历史问题就答不上来了。
 */

export interface RegisteredPlugin {
  id: string
  name: string
  version: string
  /** 从哪个目录扫出来的，决定它在语言包冲突里的优先级，也决定能不能卸载 */
  source: LocaleSourceTier
  /** 插件目录名（不是全路径 —— 渲染进程不需要知道用户的磁盘布局） */
  dir: string
  permissions: string[]
  /** 这个插件贡献的视图 id，供设置界面展示 */
  views: string[]
  /** manifest 声明的重启需求，见 PluginDescriptor.requiresRestart */
  requiresRestart: boolean
  /** 插件自述，用于详情页。manifest 目前还没有这个字段，先留空 */
  description?: string
}

export class PluginRegistry {
  private plugins = new Map<string, RegisteredPlugin>()

  register(manifest: PluginManifest, source: LocaleSourceTier, dir: string): void {
    this.plugins.set(manifest.id, {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      source,
      dir,
      permissions: manifest.permissions ?? [],
      views: (manifest.contributes?.views ?? []).map((view) => view.id),
      requiresRestart: manifest.requiresRestart === true
    })
  }

  getAll(): RegisteredPlugin[] {
    return Array.from(this.plugins.values())
  }

  unregister(pluginId: string): void {
    this.plugins.delete(pluginId)
  }
}

export const pluginRegistry = new PluginRegistry()
