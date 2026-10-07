import type { PluginViewDescriptor } from '@shared/plugin-api'

/**
 * 视图注册表：只存「元信息」，永远不存组件、路径或加载函数。
 */
export class UIRegistry {
  private views = new Map<string, PluginViewDescriptor>()

  register(view: PluginViewDescriptor): void {
    this.views.set(view.id, view)
  }

  get(viewId: string): PluginViewDescriptor | undefined {
    return this.views.get(viewId)
  }

  getAll(): PluginViewDescriptor[] {
    return Array.from(this.views.values())
  }

  unregisterByPlugin(pluginId: string): void {
    for (const [viewId, view] of this.views) {
      if (view.pluginId === pluginId) this.views.delete(viewId)
    }
  }
}

export const uiRegistry = new UIRegistry()
