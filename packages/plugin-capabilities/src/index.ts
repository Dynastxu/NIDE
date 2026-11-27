import type { NideContext } from '@nide/kernel/context.ts'
import { PluginCapabilities } from './capabilities.ts'

/**
 * 插件桌面能力服务（`plugin-capabilities`）。
 *
 * 管的是「插件能不能打开外链 / 弹对话框 / 读写剪贴板 / 发通知」：检查的是插件的
 * `permissions.os` 声明，执行经 kernel 的 `ctx.shell` 反向桥交给 Electron。
 * 单独一个包：它是**策略检查**，不是插件生命周期的一部分。
 */
export const pluginCapabilitiesService = {
  name: 'nide:service:plugin-capabilities',
  inject: ['plugins'],

  apply(ctx: NideContext): void {
    ctx.provide('plugin-capabilities', new PluginCapabilities({ manager: ctx.plugins }))
  }
}

/** profile 直接列这个模块；loader 取 default 作为插件对象 */
export default pluginCapabilitiesService
