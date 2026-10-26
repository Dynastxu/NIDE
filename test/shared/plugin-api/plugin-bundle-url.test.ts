import { describe, expect, it } from 'vitest'
import {
  PLUGIN_BUNDLE_SCHEME,
  pluginBundleUrl,
  pluginIdFromBundleUrl
} from '@nide/contracts/plugin-api'

/**
 * 插件 bundle 的 URL 约定（`nide-plugin://plugin/<id>/client.js`）。
 *
 * 这两个纯函数是**跨进程**的接缝：渲染进程拼 URL，主进程从同一个 URL 里取 pluginId，
 * 再去 host 的清单里查绝对路径。拼错一处不会报错，只会在打包版里安静地不加载插件 UI，
 * 所以两边的往返（round-trip）要钉死。
 */

describe('pluginBundleUrl', () => {
  it('base 形态：插件的 id 进 path，host 固定成 plugin', () => {
    expect(pluginBundleUrl('builtin.demo')).toBe('nide-plugin://plugin/builtin.demo/client.js')
  })

  it('host 不是插件 id —— URL 解析会把 host 小写化，id 因此必须走 path', () => {
    const url = new URL(pluginBundleUrl('p.Node'))

    expect(url.hostname).toBe('plugin')
    expect(url.pathname).toBe('/p.Node/client.js')
  })

  it('id 里的特殊字符会被编码', () => {
    expect(pluginBundleUrl('p a/b')).toBe('nide-plugin://plugin/p%20a%2Fb/client.js')
  })
})

describe('pluginIdFromBundleUrl', () => {
  it('与 pluginBundleUrl 往返一致', () => {
    for (const pluginId of ['builtin.demo', 'user.lang-en', 'p.Node', 'p a/b']) {
      expect(pluginIdFromBundleUrl(pluginBundleUrl(pluginId))).toBe(pluginId)
    }
  })

  it('大写的 id 不会被小写化（host 在 path 里）', () => {
    expect(pluginIdFromBundleUrl('nide-plugin://plugin/My.Plugin/client.js')).toBe('My.Plugin')
  })

  it('其它协议的 URL 一律拒绝', () => {
    expect(pluginIdFromBundleUrl('https://plugin/builtin.demo/client.js')).toBeNull()
    expect(pluginIdFromBundleUrl('file:///plugin/builtin.demo/client.js')).toBeNull()
  })

  it('路径不是 client.js 的拒绝', () => {
    expect(pluginIdFromBundleUrl('nide-plugin://plugin/builtin.demo/other.js')).toBeNull()
    expect(pluginIdFromBundleUrl('nide-plugin://plugin/builtin.demo/')).toBeNull()
    expect(pluginIdFromBundleUrl('nide-plugin://plugin/client.js')).toBeNull()
  })

  it('host 不是 plugin 的拒绝（路径会指向别的东西）', () => {
    expect(pluginIdFromBundleUrl('nide-plugin://evil/builtin.demo/client.js')).toBeNull()
  })

  it('坏 URL 与坏的百分号编码给 null，不抛', () => {
    expect(pluginIdFromBundleUrl('not a url')).toBeNull()
    expect(pluginIdFromBundleUrl('nide-plugin://plugin/%E0%A4%A/client.js')).toBeNull()
  })

  it('协议名与常量一致', () => {
    expect(pluginBundleUrl('x').startsWith(`${PLUGIN_BUNDLE_SCHEME}://`)).toBe(true)
  })
})
