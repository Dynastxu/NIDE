import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginLoader, setPluginHostLogger } from '../../../src/main/plugin-host/loader'
import { settingsRegistry } from '../../../src/main/plugin-host/settings-registry'
import { languagePackRegistry } from '../../../src/main/i18n'
import { manifestNlsRegistry } from '../../../src/main/i18n/manifest-nls'
import {
  createPluginFixture,
  manifestShell,
  type PluginFixture
} from '../../fixtures/plugin-fixture'
import type { Logger } from '@shared/logger'

function silentLogger(): Logger {
  const noop = (): void => undefined
  return { error: noop, warn: noop, info: noop, debug: noop, dispatch: noop }
}

function settingsManifest(id: string, settings: unknown[]): unknown {
  return { ...manifestShell(id), contributes: { settings } }
}

describe('插件设置页加载', () => {
  let fixture: PluginFixture
  let loader: PluginLoader

  beforeEach(() => {
    fixture = createPluginFixture()
    loader = new PluginLoader()
    settingsRegistry.reset()
    languagePackRegistry.reset()
    manifestNlsRegistry.reset()
    setPluginHostLogger(silentLogger())
  })

  afterEach(() => {
    fixture.remove()
  })

  it('注册设置页并保留相对入口，标题原样存成 titleSpec', () => {
    fixture.write('p/src/settings/index.tsx', 'export default function Page() { return null }')
    const manifestPath = fixture.plugin(
      'p',
      settingsManifest('builtin.p', [{ id: 'p.settings', title: '%p.settings.title%', order: 5 }])
    )

    expect(loader.loadContributions(manifestPath)?.id).toBe('builtin.p')

    const page = settingsRegistry.getAll()[0]
    expect(page).toMatchObject({
      id: 'p.settings',
      pluginId: 'builtin.p',
      dir: 'p',
      entry: 'src/settings/index.tsx',
      order: 5,
      titleSpec: '%p.settings.title%'
    })
  })

  it('入口省略时落到 src/settings/index.tsx', () => {
    fixture.write('p/src/settings/index.tsx', 'export default function Page() { return null }')
    const manifestPath = fixture.plugin(
      'p',
      settingsManifest('builtin.p', [{ id: 'p.settings', title: 'Settings' }])
    )

    loader.loadContributions(manifestPath)
    expect(settingsRegistry.getAll()[0]?.entry).toBe('src/settings/index.tsx')
  })

  it('拒绝跑出插件目录的入口', () => {
    fixture.write('p/src/settings/index.tsx', 'export default function Page() { return null }')
    const manifestPath = fixture.plugin(
      'p',
      settingsManifest('builtin.p', [
        { id: 'p.settings', title: 'Settings', entry: '../../../evil.tsx' }
      ])
    )

    loader.loadContributions(manifestPath)
    expect(settingsRegistry.getAll()).toHaveLength(0)
  })

  it('入口文件不存在时不注册', () => {
    const manifestPath = fixture.plugin(
      'p',
      settingsManifest('builtin.p', [{ id: 'p.settings', title: 'Settings' }])
    )

    loader.loadContributions(manifestPath)
    expect(settingsRegistry.getAll()).toHaveLength(0)
  })

  it('设置页 id 不能占用宿主命名空间', () => {
    fixture.write('p/src/settings/index.tsx', 'export default function Page() { return null }')
    const manifestPath = fixture.plugin(
      'p',
      settingsManifest('builtin.p', [{ id: 'host.settings', title: 'Settings' }])
    )

    loader.loadContributions(manifestPath)
    expect(settingsRegistry.getAll()).toHaveLength(0)
  })
})
