import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/**
 * 客户端视图组件注册表（MVP）。
 *
 * 这是 `PluginSlot` 的「新来源」：插件在 `apply` 里把视图组件注册进来，
 * 渲染侧按 view id 取；取不到时 `PluginSlot` 再回退到构建期的 import.meta.glob。
 *
 * 现在组件仍由构建期 import 提供（demo 的 UI 直接 import），下一步才是
 * `nide.client` 声明 + 自定义协议把真正的运行时模块送进来。
 *
 * 和 slots 一样，不做模块增强：Cordis 的 Context 是 re-export 的，
 * 在包入口加 `interface Context` 会遮蔽原接口。用 `modulesOf(ctx)` 显式取。
 */

export type ModuleComponent = ComponentType<Record<string, never>>

export class ClientModuleRegistry {
  private readonly modules = new Map<string, ModuleComponent>()

  /** 注册一个视图组件；返回注销函数（可直接交给 ctx.effect）。 */
  register(id: string, component: ModuleComponent): () => void {
    this.modules.set(id, component)
    return () => {
      if (this.modules.get(id) === component) this.modules.delete(id)
    }
  }

  get(id: string): ModuleComponent | undefined {
    return this.modules.get(id)
  }

  count(): number {
    return this.modules.size
  }
}

export function modulesOf(ctx: Context): ClientModuleRegistry {
  const modules = ctx.get('modules')
  if (!(modules instanceof ClientModuleRegistry)) {
    throw new Error('modules service is not provided on this context')
  }
  return modules
}
