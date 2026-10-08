import type { PluginViewDescriptor } from '@shared/plugin-api'

/**
 * 注册表内部的视图记录。
 *
 * 和 PluginViewDescriptor 只差一处：`title` 换成了 `titleSpec` ——
 * 存的是 manifest 里**原样**写的值，可能是普通字符串，也可能是 `%key%` 占位符。
 *
 * 为什么不在注册时就解析掉：解析需要知道当前语言，而扫描 manifest 发生在
 * initI18n() **之前**（那时语言还没定）。所以这里只存原始值，
 * 等 host:get-plugin-views 被调用时再按**当时**的语言解析。
 * 这样切语言重建窗口后，渲染进程重新取一次视图列表就自然拿到新标题。
 */
export interface RegisteredView extends Omit<PluginViewDescriptor, 'title'> {
  /** manifest 里原样写的标题：普通字符串，或 "%some.key%" */
  titleSpec: string
}

/**
 * 视图注册表：只存「元信息」，永远不存组件、路径或加载函数。
 */
export class UIRegistry {
  private views = new Map<string, RegisteredView>()

  register(view: RegisteredView): void {
    this.views.set(view.id, view)
  }

  get(viewId: string): RegisteredView | undefined {
    return this.views.get(viewId)
  }

  getAll(): RegisteredView[] {
    return Array.from(this.views.values())
  }

  unregisterByPlugin(pluginId: string): void {
    for (const [viewId, view] of this.views) {
      if (view.pluginId === pluginId) this.views.delete(viewId)
    }
  }
}

export const uiRegistry = new UIRegistry()
