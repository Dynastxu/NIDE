import type { ComponentType } from 'react'
import type { Context } from 'cordis'
import { loadClientBundles } from './loader'

/**
 * 客户端视图组件注册表 + 插件浏览器半的加载入口。
 *
 * 这个包是**模块层**（DSH 的 `client/modules` 同一角色）：它只回答「某个 viewId
 * 的组件在哪」「怎么把磁盘上的 bundle 取进来变成组件」。它不知道窗口、不知道
 * Cordis 树，也不 import 任何界面包 —— 所以 sdk / 界面包反向 import 它不会成环。
 *
 * 和 slots 一样，不做模块增强：Cordis 的 Context 是 re-export 的，
 * 在包入口加 `interface Context` 会遮蔽原接口。用 `modulesOf(ctx)` 显式取。
 */

export type ModuleComponent = ComponentType<Record<string, never>>

/** bundle 加载完之后由 `installModuleSink` 挂上的全局注册函数 */
interface ModuleSinkWindow {
  __NIDE_REGISTER__?: (id: string, component: ModuleComponent) => void
}

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

/**
 * 把注册表挂成插件 IIFE bundle 的全局入口。
 *
 * **必须在注入任何 bundle 之前调用**：bundle 一求值就会调
 * `window.__NIDE_REGISTER__(viewId, Component)`，挂晚了那次注册就丢了。
 */
export function installModuleSink(registry: ClientModuleRegistry): void {
  const sink = window as unknown as ModuleSinkWindow
  sink.__NIDE_REGISTER__ = (id, component) => {
    registry.register(id, component)
    console.info('[nide] client module registered by bundle', { id })
  }
}

/**
 * 按宿主当前的插件清单补加载浏览器半 bundle。
 *
 * 用在安装 / 启用第三方 UI 插件之后：renderer 启动时只会加载当时**已启用**的
 * bundle，之后新出现的插件若不补这一趟，就要重启窗口才能看到。`loadClientBundles`
 * 自己按 URL 去重，重复调用是安全的。
 *
 * 放在这里（而不是客户端树里）是因为调用方是**界面包**：主窗口订阅
 * `onPluginEnabledChanged` 时要能直接补加载，而不必反向 import 整棵客户端树。
 */
export async function reloadClientBundles(): Promise<void> {
  try {
    const descriptors = await window.hostAPI.getClientBundles()
    await loadClientBundles(descriptors)
  } catch (error) {
    console.warn('[nide] failed to reload client bundles', error)
  }
}

export { loadClientBundles }
