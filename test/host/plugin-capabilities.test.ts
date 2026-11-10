import { describe, expect, it } from 'vitest'
import { PluginCapabilities } from '../../packages/services/plugins/src/capabilities.ts'
import type { ShellMethod } from '../../packages/contracts/src/host-rpc/index.ts'
import type { PluginManager } from '../../packages/services/plugins/src/plugins.ts'
import type { PluginPermissions } from '../../packages/contracts/src/plugin-api/permissions.ts'

const GRANTS: Record<string, PluginPermissions> = {
  'demo.none': { trust: 'sandboxed' },
  'demo.open': { trust: 'sandboxed', os: { openExternal: true } },
  'demo.dialog': { trust: 'sandboxed', os: { dialogs: 'open' } },
  'demo.clipWrite': { trust: 'sandboxed', os: { clipboard: 'write' } },
  'demo.clipRead': { trust: 'sandboxed', os: { clipboard: 'read' } },
  'demo.notify': { trust: 'sandboxed', os: { notifications: true } },
  'demo.fullNoOs': { trust: 'full' }
}

function manager(): PluginManager {
  return {
    permissionsOf: (pluginId: string) => GRANTS[pluginId]
  } as unknown as PluginManager
}

function setup(): {
  capabilities: PluginCapabilities
  calls: { method: string; args: unknown[] }[]
} {
  const calls: { method: string; args: unknown[] }[] = []
  const capabilities = new PluginCapabilities({
    manager: manager(),
    call: async (method: ShellMethod, args: unknown[]) => {
      calls.push({ method, args })
      if (method === 'clipboard.readText') return 'clipboard text'
      if (method === 'dialog.open') return ['C:\\picked\\file.txt']
      if (method === 'dialog.save') return 'C:\\picked\\save.txt'
      return null
    }
  })
  return { capabilities, calls }
}

describe('PluginCapabilities：权限门槛', () => {
  it('没声明 os 时全部拒绝，且不会触达 shell', async () => {
    const { capabilities, calls } = setup()

    await expect(capabilities.openExternal('demo.none', 'https://example.com')).rejects.toThrow(
      'os.openExternal'
    )
    await expect(capabilities.showOpenDialog('demo.none')).rejects.toThrow('os.dialogs')
    await expect(capabilities.writeClipboard('demo.none', 'x')).rejects.toThrow('os.clipboard')
    await expect(capabilities.notify('demo.none', { title: 'x' })).rejects.toThrow(
      'os.notifications'
    )
    expect(calls).toEqual([])
  })

  it('完全信任不会自动放行桌面能力（仍须声明 os）', async () => {
    const { capabilities } = setup()
    await expect(capabilities.openExternal('demo.fullNoOs', 'https://example.com')).rejects.toThrow(
      'os.openExternal'
    )
  })

  it('声明后转发到对应的 shell 方法', async () => {
    const { capabilities, calls } = setup()

    await capabilities.openExternal('demo.open', 'https://example.com')
    await capabilities.openPath('demo.open', 'C:\\work\\novel')
    await capabilities.showOpenDialog('demo.dialog', { multiple: true })
    await capabilities.showSaveDialog('demo.dialog', { defaultPath: 'C:\\x.txt' })
    await capabilities.notify('demo.notify', { title: 'done', body: 'ok' })

    expect(calls.map((call) => call.method)).toEqual([
      'shell.openExternal',
      'shell.openPath',
      'dialog.open',
      'dialog.save',
      'notification.show'
    ])
  })

  it('剪贴板：write 只能写，read 才能读', async () => {
    const { capabilities, calls } = setup()

    await capabilities.writeClipboard('demo.clipWrite', 'hello')
    await expect(capabilities.readClipboard('demo.clipWrite')).rejects.toThrow('os.clipboard')

    await capabilities.writeClipboard('demo.clipRead', 'hello')
    await expect(capabilities.readClipboard('demo.clipRead')).resolves.toBe('clipboard text')
    expect(calls.filter((call) => call.method === 'clipboard.readText')).toHaveLength(1)
  })

  it('对话框返回值被收敛成字符串数组 / null', async () => {
    const { capabilities } = setup()
    await expect(capabilities.showOpenDialog('demo.dialog')).resolves.toEqual([
      'C:\\picked\\file.txt'
    ])
    await expect(capabilities.showSaveDialog('demo.dialog')).resolves.toBe('C:\\picked\\save.txt')
  })

  it('未知插件直接拒绝', async () => {
    const { capabilities } = setup()
    await expect(capabilities.openExternal('ghost', 'https://example.com')).rejects.toThrow(
      '不在清单里'
    )
  })
})
