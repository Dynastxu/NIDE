import type {
  PluginDialogOptions,
  PluginHostCapabilities
} from '../../../../packages/contracts/src/plugin-api/backend.ts'
import { allowsLegacy } from '../../../../packages/contracts/src/plugin-api/permissions.ts'
import type { ShellMethod } from '../../../../packages/contracts/src/host-rpc/index.ts'
import { shell } from '../../../kernel/src/shell.ts'
import type { PluginManager } from './plugins.ts'

/**
 * 插件后端的桌面能力（`ctx.host.*`）。
 *
 * 与 mics 一致：这些能力**永远要声明**（`permissions.os`），`trust: 'full'` 也不
 * 自动放行 —— 「完全信任」约束的是文件 / 子进程，不是替用户点开外链、弹对话框。
 *
 * 真正执行在 shell（host 里没有 Electron），走既有的 `ctx.shell` 反向桥。
 * `call` 可注入，测试不必起 Electron。
 */

export type ShellCall = (method: ShellMethod, args: unknown[]) => Promise<unknown>

export interface PluginCapabilitiesOptions {
  manager: PluginManager
  /** 默认走 `shell.call`；测试可注入 */
  call?: ShellCall
}

export class PluginCapabilities {
  private readonly options: PluginCapabilitiesOptions
  private readonly call: ShellCall

  constructor(options: PluginCapabilitiesOptions) {
    this.options = options
    this.call =
      options.call ?? ((method, args) => shell.call<unknown>(method, args) as Promise<unknown>)
  }

  async openExternal(pluginId: string, url: string): Promise<void> {
    this.require(pluginId, 'shell:openExternal', 'os.openExternal')
    await this.call('shell.openExternal', [url])
  }

  async openPath(pluginId: string, target: string): Promise<void> {
    this.require(pluginId, 'shell:openExternal', 'os.openExternal')
    await this.call('shell.openPath', [target])
  }

  async showOpenDialog(pluginId: string, options?: PluginDialogOptions): Promise<string[]> {
    this.require(pluginId, 'dialog:open', 'os.dialogs')
    const result = await this.call('dialog.open', [options ?? {}])
    return Array.isArray(result) ? result.map(String) : []
  }

  async showSaveDialog(pluginId: string, options?: PluginDialogOptions): Promise<string | null> {
    this.require(pluginId, 'dialog:open', 'os.dialogs')
    const result = await this.call('dialog.save', [options ?? {}])
    return typeof result === 'string' ? result : null
  }

  async readClipboard(pluginId: string): Promise<string> {
    this.requireClipboard(pluginId, 'read')
    const result = await this.call('clipboard.readText', [])
    return typeof result === 'string' ? result : ''
  }

  async writeClipboard(pluginId: string, text: string): Promise<void> {
    this.requireClipboard(pluginId, 'write')
    await this.call('clipboard.writeText', [text])
  }

  async notify(pluginId: string, options: { title: string; body?: string }): Promise<void> {
    this.require(pluginId, 'notifications:show', 'os.notifications')
    await this.call('notification.show', [options])
  }

  /** 给后端 worker 用的一份门面：绑定 pluginId，形状与 `PluginHostCapabilities` 一致 */
  forPlugin(pluginId: string): PluginHostCapabilities {
    return {
      openExternal: (url) => this.openExternal(pluginId, url),
      openPath: (target) => this.openPath(pluginId, target),
      showOpenDialog: (options) => this.showOpenDialog(pluginId, options),
      showSaveDialog: (options) => this.showSaveDialog(pluginId, options),
      readClipboard: () => this.readClipboard(pluginId),
      writeClipboard: (text) => this.writeClipboard(pluginId, text),
      notify: (options) => this.notify(pluginId, options)
    }
  }

  private require(pluginId: string, legacy: string, label: string): void {
    const permissions = this.options.manager.permissionsOf(pluginId)
    if (!permissions) throw new Error(`插件 ${pluginId} 不在清单里`)
    if (!allowsLegacy(permissions, legacy)) {
      throw new Error(`插件 ${pluginId} 没有声明权限 ${label}`)
    }
  }

  private requireClipboard(pluginId: string, mode: 'read' | 'write'): void {
    const permissions = this.options.manager.permissionsOf(pluginId)
    if (!permissions) throw new Error(`插件 ${pluginId} 不在清单里`)

    const scope = permissions.os?.clipboard
    const allowed = mode === 'read' ? scope === 'read' : scope === 'write' || scope === 'read'
    if (!allowed) {
      throw new Error(`插件 ${pluginId} 没有声明权限 os.clipboard（${mode}）`)
    }
  }
}
