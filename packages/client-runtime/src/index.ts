import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '@nide/client-ui-slots'
import { ClientModuleRegistry, type ModuleComponent } from '@nide/client-modules'
import { loadClientBundles } from './loader'

/**
 * 浏览器侧的 Cordis 根上下文（MVP）。
 *
 * 每个窗口一棵树，按 `windowType` 只加载它真正需要的插件：
 * - main -> `main.root` + `zone.*` + demo 的 client 半
 * - welcome -> `welcome.root`
 * - settings -> 暂时不接 slot，仍走旧路径
 *
 * 这样主窗口不会把 WelcomeApp 拖进来，欢迎窗口也不会加载 Monaco。
 *
 * TODO（阶段 3 的后续）：
 * - 客户端插件 loader / boot graph（现在是按 windowType 硬编码）
 * - `nide.client` 声明与自定义协议加载
 * - list / keyed slot 语义
 * - HMR
 */

export type WindowType = 'main' | 'welcome' | 'settings'

export interface ClientRuntimeOptions {
  windowType: WindowType
}

export interface ClientRuntime {
  ctx: Context
  /** slot 注册表；渲染侧用 `<SlotProvider registry={runtime.slots}>` 绑定。 */
  slots: SlotRegistry
  /** 视图组件注册表；`PluginSlot` 优先从这里取。 */
  modules: ClientModuleRegistry
  /** 释放整棵客户端树（测试 / 热重载用）。 */
  dispose: () => Promise<void>
}

/** 当前 renderer 的客户端树；给 `PluginSlot` 这类非插件代码取服务用。 */
let currentRuntime: ClientRuntime | null = null

export function getClientRuntime(): ClientRuntime | null {
  return currentRuntime
}

/** 最小客户端插件：证明激活与释放。 */
function clientHello(ctx: Context): void {
  const logger = ctx.logger('client-hello')
  logger.info('client cordis is alive')

  ctx.effect(
    () => () => {
      logger.info('client cordis disposed')
    },
    'client-hello: dispose-log'
  )
}

interface DisposableFiber {
  dispose: () => Promise<void>
}

async function loadWindowPlugin(ctx: Context, windowType: WindowType): Promise<DisposableFiber[]> {
  if (windowType === 'main') {
    const [{ mainPlugin }, { layoutPlugin }] = await Promise.all([
      import('@nide/client-ui-main'),
      import('@nide/client-ui-layout')
    ])

    return [await ctx.plugin(mainPlugin), await ctx.plugin(layoutPlugin)]
  }

  if (windowType === 'welcome') {
    const { welcomePlugin } = await import('@nide/client-ui-welcome')
    return [await ctx.plugin(welcomePlugin)]
  }

  if (windowType === 'settings') {
    const { settingsPlugin } = await import('@nide/client-ui-settings')
    return [await ctx.plugin(settingsPlugin)]
  }

  return []
}

export async function createClientRuntime(options: ClientRuntimeOptions): Promise<ClientRuntime> {
  const ctx = new Context()

  // TODO: 换成 renderer 的 logger（带主进程落盘），现在是控制台直出。
  ctx.logger.exporter({
    export(message) {
      console.log(`[client:${message.name}]`, ...message.args)
    }
  })

  const slots = new SlotRegistry()
  const modules = new ClientModuleRegistry()

  // `Context.provide` 的泛型签名要求 key 先出现在 Context 上；这里用结构化调用
  // 避开模块增强（原因见 client-ui-slots 的 slotsOf 注释）。
  const provide = (
    ctx as unknown as { provide: (name: string, value: unknown) => void }
  ).provide.bind(ctx)
  provide('slots', slots)
  provide('modules', modules)

  /**
   * 插件 IIFE bundle 加载时调用这个全局注册视图组件。
   * 必须在注入任何 bundle 之前挂好。
   */
  ;(
    window as unknown as {
      __NIDE_REGISTER__?: (id: string, component: ModuleComponent) => void
    }
  ).__NIDE_REGISTER__ = (id, component) => {
    modules.register(id, component)
    console.info('[nide] client module registered by bundle', { id })
  }

  const helloFiber = ctx.plugin(clientHello)
  await helloFiber

  const windowFibers = await loadWindowPlugin(ctx, options.windowType)

  // 主窗口的视图组件由插件的浏览器半提供；没有 bundle / 构建失败时
  // PluginSlot 仍会回退到构建期 glob，界面不受影响。
  if (options.windowType === 'main') {
    try {
      const descriptors = await window.hostAPI.getClientBundles()
      await loadClientBundles(descriptors)
    } catch (error) {
      console.warn('[nide] failed to load client bundles', error)
    }
  }

  const runtime: ClientRuntime = {
    ctx,
    slots,
    modules,
    dispose: async () => {
      currentRuntime = null
      for (const fiber of [...windowFibers].reverse()) await fiber.dispose()
      await helloFiber.dispose()
    }
  }

  currentRuntime = runtime
  return runtime
}
