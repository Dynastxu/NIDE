import { Context } from 'cordis'
import { SlotRegistry } from '@nide/client-ui-slots'
import { ClientModuleRegistry, type ModuleComponent } from '@nide/client-modules'
import { loadClientBundles } from './loader'
import { CLIENT_ROSTER } from './roster.generated'
import type { ClientWindowType } from './window-type.ts'

/**
 * 浏览器侧的 Cordis 根上下文。
 *
 * 每个窗口一棵树，按 `windowType` 只加载它真正需要的插件。**哪些包属于哪个窗口
 * 不在代码里**：各界面包在 package.json 的 `nide.client.windowTypes` 声明，由
 * `scripts/gen-client-roster.mjs` 生成静态 import 表（`roster.generated.ts`）。
 * 加一个窗口 = 新增一个包 + 跑一次生成脚本，本文件不用改。
 *
 * 这样主窗口不会把 WelcomeApp 拖进来，欢迎窗口也不会加载 Monaco。
 *
 * TODO：
 * - list / keyed slot 语义
 * - HMR
 */

export type WindowType = ClientWindowType

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

/**
 * 按宿主当前的插件清单补加载浏览器半 bundle。
 *
 * 用在安装 / 启用第三方 UI 插件之后：renderer 启动时只会加载当时**已启用**的
 * bundle，之后新出现的插件若不补这一趟，就要重启窗口才能看到。`loadClientBundles`
 * 自己按 URL 去重，重复调用是安全的。
 */
export async function reloadClientBundles(): Promise<void> {
  if (!currentRuntime) return

  try {
    const descriptors = await window.hostAPI.getClientBundles()
    await loadClientBundles(descriptors)
  } catch (error) {
    console.warn('[nide] failed to reload client bundles', error)
  }
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

/**
 * 按窗口种类挂载花名册里的插件。
 *
 * `load` 用动态 import：每个窗口只下载它自己的界面（设置窗口不该吃下 Monaco）。
 * 过滤发生在 `await load()` **之前** —— `windowTypes` 是生成物里的静态元数据。
 */
async function loadWindowPlugin(ctx: Context, windowType: WindowType): Promise<DisposableFiber[]> {
  const fibers: DisposableFiber[] = []

  for (const entry of CLIENT_ROSTER) {
    if (!entry.windowTypes.includes(windowType)) continue

    const module = await entry.load()
    for (const plugin of module.clientPlugins) {
      fibers.push(await ctx.plugin(plugin as Parameters<Context['plugin']>[0]))
    }
  }

  return fibers
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
