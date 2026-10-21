import type { PluginSettingsDescriptor } from '@shared/plugin-api'

/**
 * 设置页注册表：只存元信息，不存组件、路径或加载函数。
 *
 * 和 UIRegistry 的差别只有一处：`title` 换成了 `titleSpec` —— 存 manifest 里
 * 原样的值（可能是 `%key%`），等 host:get-plugin-settings 被调用时再按**当时**
 * 的语言解析。扫描 manifest 发生在 initI18n() 之前，这里不能提前解析。
 */
export interface RegisteredSettings extends Omit<PluginSettingsDescriptor, 'title'> {
  titleSpec: string
}

export class SettingsRegistry {
  private pages = new Map<string, RegisteredSettings>()

  register(page: RegisteredSettings): void {
    // 用 pluginId + id 做键：设置 id 只保证插件内唯一，两个插件都叫
    // "providers" 是合法的，不能用 id 直接覆盖
    this.pages.set(`${page.pluginId}:${page.id}`, page)
  }

  getAll(): RegisteredSettings[] {
    return Array.from(this.pages.values())
  }

  unregisterByPlugin(pluginId: string): void {
    for (const [id, page] of this.pages) {
      if (page.pluginId === pluginId) this.pages.delete(id)
    }
  }

  /** 只给测试用：模块级单例，多个用例之间会互相污染 */
  reset(): void {
    this.pages.clear()
  }
}

export const settingsRegistry = new SettingsRegistry()
