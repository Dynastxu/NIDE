import { describe, expect, it } from 'vitest'
import { HOST_CHANNELS, HOST_EVENT_CHANNELS } from '@shared/host'

/**
 * 宿主通道名的契约。
 *
 * 这些字符串的**两端**（main/ipc/host.ipc.ts 的注册与 preload/index.ts 的调用）
 * 之间没有任何编译期关联：拼错、改名漏改一处都不会报错，只会 invoke 永不 resolve、
 * send 石沉大海。所以这里把名字钉住 —— 改通道名必须同时改这份断言，改动因此
 * 不可能悄悄漏掉一端。
 *
 * 事件总线上的频道名（HOST_EVENT_CHANNELS）同理，而且它失效起来更隐蔽：界面
 * 什么都不报错，只是不更新。
 */
describe('HOST_CHANNELS', () => {
  it('名字被钉住（改通道名必须同时改这里）', () => {
    expect(HOST_CHANNELS).toEqual({
      getPluginViews: 'host:get-plugin-views',
      getPluginSettings: 'host:get-plugin-settings',
      getI18n: 'host:get-i18n',
      getPlugins: 'host:get-plugins',
      getClientBundles: 'host:get-client-bundles',
      setPluginEnabled: 'host:set-plugin-enabled',
      getDisabledPlugins: 'host:get-disabled-plugins',
      getTheme: 'host:get-theme',
      setTheme: 'host:set-theme',
      setLocale: 'host:set-locale',
      showStripeMenu: 'host:show-stripe-menu',
      reloadPlugin: 'host:reload-plugin',
      installPlugin: 'host:install-plugin',
      removePlugin: 'host:remove-plugin',
      eventEmit: 'host:event-emit',
      editorChange: 'host:editor-change',
      event: 'host:event',
      fileChanged: 'host:file-changed',
      showDiff: 'host:show-diff'
    })
  })

  it('一律带 host: 前缀，且非空', () => {
    for (const name of Object.values(HOST_CHANNELS)) {
      expect(name.startsWith('host:')).toBe(true)
      // 只有一个前缀不算通道名
      expect(name.length).toBeGreaterThan('host:'.length)
    }
  })

  it('没有两个键指向同一条通道', () => {
    /**
     * 复制粘贴出来的重复值：两条不同的能力被接到同一条通道上，表现是其中一个
     * 静默地干另一个的活。类型和前缀检查都发现不了，所以单独断言。
     */
    const names = Object.values(HOST_CHANNELS)
    expect(new Set(names).size).toBe(names.length)
  })

  it('总线那条通道本身也是其中之一', () => {
    // 事件总线的发送方（pushEventToRenderer）与接收方都靠它对上
    expect(HOST_CHANNELS.event).toBe('host:event')
  })
})

describe('HOST_EVENT_CHANNELS', () => {
  it('是总线上的频道名，不是独立的 Electron 事件名', () => {
    /**
     * 这是最容易搞错的一点：它们不能拿去做 `on()` / `send()` 的通道参数，
     * 只能作为 `HOST_CHANNELS.event` 载荷的第一个参数。所以它们**不带**
     * `host:` 前缀 —— 加上去反而会和真正的通道名混淆。
     */
    for (const name of Object.values(HOST_EVENT_CHANNELS)) {
      expect(name.startsWith('host:')).toBe(false)
      expect(name.length).toBeGreaterThan(0)
    }

    expect(HOST_EVENT_CHANNELS.pluginEnabledChanged).toBe('plugin:enabled-changed')
  })

  it('不与任何 IPC 通道重名', () => {
    const ipcNames = new Set<string>(Object.values(HOST_CHANNELS))
    for (const name of Object.values(HOST_EVENT_CHANNELS)) {
      expect(ipcNames.has(name)).toBe(false)
    }
  })
})
