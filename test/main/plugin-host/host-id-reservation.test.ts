import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginLoader, setPluginHostLogger } from '../../../src/main/plugin-host/loader'
import { permissionManager } from '../../../src/main/plugin-host/permission'
import { uiRegistry } from '../../../src/main/plugin-host/ui-registry'
import { languagePackRegistry } from '../../../src/main/i18n'
import { manifestNlsRegistry } from '../../../src/main/i18n/manifest-nls'
import { isReservedHostId } from '@shared/plugin-api'
import {
  createPluginFixture,
  localeManifest,
  type PluginFixture
} from '../../fixtures/plugin-fixture'
import type { Logger } from '@shared/logger'

/** 记录调用的 logger 假件，与 locale-loader.test.ts 同款 */
function spyLogger(): Logger & { calls: Array<[string, string, unknown]> } {
  const calls: Array<[string, string, unknown]> = []
  const record =
    (level: string) =>
    (text: string, fields?: Record<string, unknown>): void => {
      calls.push([level, text, fields])
    }

  return {
    calls,
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    dispatch: (level, text, fields) => calls.push([level, text, fields])
  }
}

/** 造一个贡献单个视图的 manifest，视图 id 可指定 */
function viewManifest(pluginId: string, viewId: string, entry = 'src/ui/index.tsx'): unknown {
  return {
    id: pluginId,
    name: pluginId,
    version: '1.0.0',
    contributes: {
      views: [{ id: viewId, title: '占位标题', location: 'rightTop', entry }]
    }
  }
}

describe('宿主保留 id 空间', () => {
  describe('isReservedHostId', () => {
    it('HOST_VIEW_PLUGIN_ID 本身算越界', () => {
      expect(isReservedHostId('host')).toBe(true)
    })

    it('内建视图 id 算越界', () => {
      expect(isReservedHostId('host.explorer')).toBe(true)
      expect(isReservedHostId('host.git')).toBe(true)
      expect(isReservedHostId('host.commit')).toBe(true)
    })

    it('只是前缀相同的普通名字不算越界', () => {
      expect(isReservedHostId('hostile')).toBe(false)
      expect(isReservedHostId('hostile.git')).toBe(false)
      expect(isReservedHostId('builtin.demo')).toBe(false)
      expect(isReservedHostId('')).toBe(false)
    })
  })

  describe('加载器', () => {
    let fixture: PluginFixture
    let loader: PluginLoader
    let logger: ReturnType<typeof spyLogger>

    beforeEach(() => {
      fixture = createPluginFixture()
      loader = new PluginLoader()
      languagePackRegistry.reset()
      manifestNlsRegistry.reset()
      uiRegistry.reset()

      logger = spyLogger()
      setPluginHostLogger(logger)
    })

    afterEach(() => {
      fixture.remove()
      languagePackRegistry.reset()
      manifestNlsRegistry.reset()
      uiRegistry.reset()
      vi.restoreAllMocks()
    })

    it('插件 id 占用 host 命名空间时整个 manifest 被拒绝', () => {
      const manifestPath = fixture.plugin('evil', viewManifest('host', 'evil.view'))

      expect(loader.loadContributions(manifestPath, 'third-party')).toBeNull()
      expect(uiRegistry.getAll()).toEqual([])
      expect(logger.calls.filter(([level]) => level === 'error')).toHaveLength(1)
    })

    it('插件 id 取内建视图名（host.git）同样被拒绝', () => {
      const manifestPath = fixture.plugin('evil-git', viewManifest('host.git', 'evil.view'))

      expect(loader.loadContributions(manifestPath, 'third-party')).toBeNull()
      expect(uiRegistry.getAll()).toEqual([])
    })

    it('被拒绝的插件不会登记权限', () => {
      const manifestPath = fixture.plugin('evil-perm', {
        ...(viewManifest('host', 'evil.view') as object),
        permissions: ['fs:read']
      })

      loader.loadContributions(manifestPath, 'third-party')

      expect(permissionManager.check('host', 'fs:read')).toBe(false)
    })

    it('被拒绝的插件连语言包一起拒绝（词条表是全局共享的）', () => {
      const manifestPath = fixture.plugin(
        'evil-locale',
        localeManifest('host', 'en-US', 'locales/en-US.json', 'English')
      )
      fixture.write('evil-locale/locales/en-US.json', { 'host.diff.close': 'LEAKED' })

      expect(loader.loadContributions(manifestPath, 'third-party')).toBeNull()
      expect(languagePackRegistry.getAll()).toEqual([])
    })

    it('视图 id 占用保留空间时只跳过这一个视图，插件其余部分照常', () => {
      const manifestPath = fixture.plugin('p-viewid', {
        id: 'p.viewid',
        name: 'p.viewid',
        version: '1.0.0',
        contributes: {
          views: [
            { id: 'host.git', title: '冒名顶替', location: 'bottomLeft', entry: 'src/ui/a.tsx' },
            { id: 'p.viewid.ok', title: '正常视图', location: 'rightTop', entry: 'src/ui/b.tsx' }
          ]
        }
      })

      const manifest = loader.loadContributions(manifestPath, 'third-party')

      expect(manifest?.id).toBe('p.viewid')
      expect(uiRegistry.getAll().map((view) => view.id)).toEqual(['p.viewid.ok'])
      expect(logger.calls.filter(([level]) => level === 'error')).toHaveLength(1)
    })

    it('合法的插件 id 与视图 id 不受影响', () => {
      const manifestPath = fixture.plugin('p-ok', viewManifest('p.ok', 'p.ok.view'))

      const manifest = loader.loadContributions(manifestPath, 'third-party')

      expect(manifest?.id).toBe('p.ok')
      expect(uiRegistry.getAll().map((view) => view.id)).toEqual(['p.ok.view'])
    })
  })
})
