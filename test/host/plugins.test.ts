import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginManager, pluginPreferencePath } from '../../packages/host/src/services/plugins.ts'
import { parsePluginPreference } from '../../src/shared/plugin-api/preference.ts'

/**
 * host 侧插件清单与启用状态。
 *
 * 这一层只碰纯数据（manifest / 偏好文件 / bundle 路径），不起 Electron，所以用例
 * 全用真的临时目录。重点撞「静默出错」的几处：保留 id、坏 manifest、bundle 逃出
 * 插件目录、禁用状态没落盘、第三方覆盖内置。
 */

let base = ''
let builtinDir = ''
let thirdPartyDir = ''
let userDataDir = ''

function manager(): PluginManager {
  return new PluginManager({
    builtinDir,
    thirdPartyDir,
    preferencePath: pluginPreferencePath(userDataDir)
  })
}

async function writePlugin(
  root: string,
  dir: string,
  manifest: Record<string, unknown>
): Promise<void> {
  const pluginDir = path.join(root, dir)
  await fs.mkdir(pluginDir, { recursive: true })
  await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8')
}

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nide-plugins-')))
  builtinDir = path.join(base, 'plugins', 'builtin')
  thirdPartyDir = path.join(base, 'user-data', 'plugins')
  userDataDir = path.join(base, 'user-data')
  await fs.mkdir(builtinDir, { recursive: true })
  await fs.mkdir(thirdPartyDir, { recursive: true })
  await fs.mkdir(userDataDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

describe('PluginManager：扫描', () => {
  it('列出内置与第三方插件，按名称排序，内置标记正确', async () => {
    await writePlugin(builtinDir, 'demo', {
      id: 'builtin.demo',
      name: 'Demo',
      version: '1.0.0',
      contributes: { views: [{ id: 'demo.hello' }] }
    })
    await writePlugin(thirdPartyDir, 'lang-en', {
      id: 'user.lang-en',
      name: 'English',
      version: '0.1.0'
    })

    const plugins = manager().list()

    expect(plugins.map((plugin) => plugin.id)).toEqual(['builtin.demo', 'user.lang-en'])
    expect(plugins[0]).toMatchObject({
      builtin: true,
      dir: 'demo',
      views: ['demo.hello'],
      permissions: [],
      requiresRestart: false
    })
    expect(plugins[1]).toMatchObject({ builtin: false, views: [] })
  })

  it('第三方与内置撞 id 时第三方覆盖内置', async () => {
    await writePlugin(builtinDir, 'demo', {
      id: 'same.id',
      name: 'Builtin',
      version: '1.0.0'
    })
    await writePlugin(thirdPartyDir, 'demo-user', {
      id: 'same.id',
      name: 'User',
      version: '2.0.0'
    })

    const plugins = manager().list()

    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toMatchObject({ name: 'User', builtin: false })
  })

  it('拒绝占用 host 命名空间的 id', async () => {
    await writePlugin(builtinDir, 'evil', {
      id: 'host',
      name: 'Evil',
      version: '1.0.0'
    })

    expect(manager().list()).toEqual([])
  })

  it('忽略缺字段与坏 JSON 的 manifest', async () => {
    await writePlugin(builtinDir, 'missing', { id: 'x.y' })
    const brokenDir = path.join(builtinDir, 'broken')
    await fs.mkdir(brokenDir, { recursive: true })
    await fs.writeFile(path.join(brokenDir, 'manifest.json'), '{ not json', 'utf-8')

    expect(manager().list()).toEqual([])
  })
})

describe('PluginManager：启用状态', () => {
  it('默认全启用，禁用后落盘，新实例读得回来', async () => {
    await writePlugin(builtinDir, 'demo', {
      id: 'builtin.demo',
      name: 'Demo',
      version: '1.0.0'
    })

    const first = manager()
    expect(first.disabled()).toEqual([])

    first.setEnabled('builtin.demo', false)
    expect(first.disabled()).toEqual(['builtin.demo'])

    const saved = parsePluginPreference(
      JSON.parse(await fs.readFile(pluginPreferencePath(userDataDir), 'utf-8'))
    )
    expect(saved.disabled).toEqual(['builtin.demo'])
    expect(manager().disabled()).toEqual(['builtin.demo'])

    first.setEnabled('builtin.demo', true)
    expect(manager().disabled()).toEqual([])
  })

  it('禁用 id 排序稳定，重复提交不额外写盘', async () => {
    await writePlugin(builtinDir, 'demo', {
      id: 'builtin.demo',
      name: 'Demo',
      version: '1.0.0'
    })

    const plugins = manager()
    plugins.setEnabled('builtin.demo', false)
    const file = pluginPreferencePath(userDataDir)
    const first = await fs.readFile(file, 'utf-8')

    plugins.setEnabled('builtin.demo', false)
    expect(await fs.readFile(file, 'utf-8')).toBe(first)
  })
})

describe('PluginManager：浏览器半', () => {
  it('只返回已启用插件的 bundle 绝对路径', async () => {
    await writePlugin(builtinDir, 'demo', {
      id: 'builtin.demo',
      name: 'Demo',
      version: '1.0.0',
      client: { platform: 'web', bundle: 'dist/client.js' }
    })

    const plugins = manager()
    const [bundle] = plugins.clientBundles()

    expect(bundle).toEqual({
      pluginId: 'builtin.demo',
      platform: 'web',
      bundlePath: path.join(builtinDir, 'demo', 'dist', 'client.js')
    })

    plugins.setEnabled('builtin.demo', false)
    expect(plugins.clientBundles()).toEqual([])
  })

  it('bundle 路径逃出插件目录时不返回', async () => {
    await writePlugin(builtinDir, 'demo', {
      id: 'builtin.demo',
      name: 'Demo',
      version: '1.0.0',
      client: { platform: 'web', bundle: '../outside.js' }
    })

    expect(manager().clientBundles()).toEqual([])
  })
})

describe('PluginManager：重新扫描', () => {
  it('扫描之后能看到新装进目录的插件', async () => {
    const plugins = manager()
    expect(plugins.list()).toEqual([])

    await writePlugin(thirdPartyDir, 'new', {
      id: 'user.new',
      name: 'New',
      version: '1.0.0'
    })

    plugins.scan()
    expect(plugins.list().map((plugin) => plugin.id)).toEqual(['user.new'])
  })
})

describe('PluginManager：安装 / 卸载', () => {
  async function incomingPlugin(dir: string, manifest: Record<string, unknown>): Promise<string> {
    const incoming = path.join(base, 'incoming')
    await writePlugin(incoming, dir, manifest)
    return path.join(incoming, dir)
  }

  it('从文件夹安装：复制进 userData、默认禁用、清单可见', async () => {
    const source = await incomingPlugin('my-plugin', {
      id: 'user.my',
      name: 'My',
      version: '1.0.0'
    })
    const plugins = manager()

    const result = plugins.install(source)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plugin).toMatchObject({ id: 'user.my', builtin: false, dir: 'my-plugin' })
    expect((await fs.stat(path.join(thirdPartyDir, 'my-plugin', 'manifest.json'))).isFile()).toBe(
      true
    )
    expect(plugins.list().map((plugin) => plugin.id)).toEqual(['user.my'])
    expect(plugins.disabled()).toEqual(['user.my'])
    expect(plugins.clientBundles()).toEqual([])
  })

  it('同名插件 / 同名目录都拒绝覆盖', async () => {
    const source = await incomingPlugin('dup', {
      id: 'user.dup',
      name: 'Dup',
      version: '1.0.0'
    })
    const plugins = manager()

    expect(plugins.install(source).ok).toBe(true)
    expect(plugins.install(source)).toEqual({ ok: false, reason: 'already-exists' })
  })

  it('没有 manifest 的目录拒绝安装', async () => {
    const empty = path.join(base, 'empty')
    await fs.mkdir(empty, { recursive: true })

    expect(manager().install(empty)).toEqual({ ok: false, reason: 'invalid-plugin' })
  })

  it('卸载第三方插件删掉目录，内置 / 不存在都拒绝', async () => {
    await writePlugin(builtinDir, 'demo', {
      id: 'builtin.demo',
      name: 'Demo',
      version: '1.0.0'
    })
    const source = await incomingPlugin('gone', {
      id: 'user.gone',
      name: 'Gone',
      version: '1.0.0'
    })

    const plugins = manager()
    expect(plugins.install(source).ok).toBe(true)

    const removed = plugins.remove('user.gone')
    expect(removed.ok).toBe(true)
    expect(await fs.stat(path.join(thirdPartyDir, 'gone')).catch(() => null)).toBe(null)
    expect(plugins.list().map((plugin) => plugin.id)).toEqual(['builtin.demo'])

    expect(plugins.remove('builtin.demo')).toEqual({ ok: false, reason: 'builtin' })
    expect(plugins.remove('user.nope')).toEqual({ ok: false, reason: 'not-found' })
  })
})
