import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginLoader, setPluginHostLogger } from '../src/main/plugin-host/loader'
import { languagePackRegistry } from '../src/main/i18n'
import { manifestNlsRegistry } from '../src/main/i18n/manifest-nls'
import {
  createPluginFixture,
  localeManifest,
  manifestShell,
  type PluginFixture
} from './helpers/plugin-fixture'
import type { Logger } from '@shared/logger'

/** 造一个记录调用的 logger 假件。加载器只用到日志出口，不关心实现 */
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

/** 造一个贡献单个视图的 manifest（用于覆盖 %key% 占位符那条路径） */
function viewManifest(id: string, title: string): unknown {
  return {
    ...manifestShell(id),
    contributes: {
      views: [{ id: `${id}.view`, title, location: 'rightTop', entry: 'src/ui/index.tsx' }]
    }
  }
}

describe('插件加载器', () => {
  let fixture: PluginFixture
  let loader: PluginLoader
  let logger: ReturnType<typeof spyLogger>

  beforeEach(() => {
    fixture = createPluginFixture()
    loader = new PluginLoader()
    languagePackRegistry.reset()
    manifestNlsRegistry.reset()

    /**
     * 日志出口换成假件。
     *
     * 这些用例刻意制造坏输入，加载器会报一堆告警 —— 换成假件既静音了输出，
     * 又让「有没有报警」可断言，比 spy 在 console 上更贴近真实调用点。
     * 顺带避免了让这个纯逻辑测试去加载 electron-log（它依赖 Electron）。
     */
    logger = spyLogger()
    setPluginHostLogger(logger)
  })

  afterEach(() => {
    fixture.remove()
    languagePackRegistry.reset()
    manifestNlsRegistry.reset()
    vi.restoreAllMocks()
  })

  describe('语言包', () => {
    it('纯数据插件（没有 views）也能注册语言包', () => {
      const manifestPath = fixture.plugin(
        'p-ok',
        localeManifest('p.ok', 'en-US', 'locales/en-US.json', 'English')
      )
      fixture.write('p-ok/locales/en-US.json', { 'host.diff.close': 'Close' })

      loader.loadContributions(manifestPath, 'builtin')

      expect(languagePackRegistry.getAll()).toHaveLength(1)
    })

    it('locale 被规范化，来源层级透传，dir 取自插件目录名', () => {
      const manifestPath = fixture.plugin(
        'p-ok',
        localeManifest('p.ok', 'en-us', 'locales/x.json', 'English')
      )
      fixture.write('p-ok/locales/x.json', { 'host.diff.close': 'Close' })

      loader.loadContributions(manifestPath, 'third-party')

      const [entry] = languagePackRegistry.getAll()
      expect(entry.locale).toBe('en-US')
      expect(entry.source).toBe('third-party')
      expect(entry.dir).toBe('p-ok')
      expect(entry.messages).toEqual({ 'host.diff.close': 'Close' })
    })

    it('拒绝 ../ 路径穿越（目标文件真实存在，证明是守卫拦下的）', () => {
      fixture.write('outside.json', { 'host.diff.close': 'LEAKED' })
      const manifestPath = fixture.plugin(
        'p-trav',
        localeManifest('p.trav', 'en-US', '../outside.json', 'x')
      )

      loader.loadContributions(manifestPath, 'third-party')

      expect(languagePackRegistry.getAll()).toEqual([])
    })

    it('拒绝绝对路径', () => {
      const absolute = fixture.write('outside.json', { 'host.diff.close': 'LEAKED' })
      const manifestPath = fixture.plugin('p-abs', localeManifest('p.abs', 'en-US', absolute, 'x'))

      loader.loadContributions(manifestPath, 'third-party')

      expect(languagePackRegistry.getAll()).toEqual([])
    })

    it('文件缺失时只跳过、不抛异常', () => {
      const manifestPath = fixture.plugin(
        'p-missing',
        localeManifest('p.missing', 'en-US', 'locales/nope.json', 'x')
      )

      expect(() => loader.loadContributions(manifestPath, 'builtin')).not.toThrow()
      expect(languagePackRegistry.getAll()).toEqual([])
    })

    it('非字符串值被跳过，字符串保留', () => {
      const manifestPath = fixture.plugin(
        'p-types',
        localeManifest('p.types', 'de', 'locales/de.json', 'Deutsch')
      )
      fixture.write('p-types/locales/de.json', {
        'host.diff.close': 'Schließen',
        'host.bad.number': 42,
        'host.bad.null': null,
        'host.bad.obj': { a: 1 }
      })

      loader.loadContributions(manifestPath, 'builtin')

      expect(Object.keys(languagePackRegistry.getAll()[0].messages)).toEqual(['host.diff.close'])
    })

    it('顶层是数组时拒绝', () => {
      const manifestPath = fixture.plugin(
        'p-array',
        localeManifest('p.array', 'fr', 'locales/fr.json', 'x')
      )
      fixture.write('p-array/locales/fr.json', '["a","b"]')

      loader.loadContributions(manifestPath, 'builtin')

      expect(languagePackRegistry.getAll()).toEqual([])
    })

    it('坏 JSON 只丢这一个包、不抛异常', () => {
      const manifestPath = fixture.plugin(
        'p-broken',
        localeManifest('p.broken', 'it', 'locales/it.json', 'x')
      )
      fixture.write('p-broken/locales/it.json', '{ not json')

      expect(() => loader.loadContributions(manifestPath, 'builtin')).not.toThrow()
      expect(languagePackRegistry.getAll()).toEqual([])
    })

    it('缺 locale/file 的条目被跳过', () => {
      const manifestPath = fixture.plugin('p-invalid', {
        ...manifestShell('p.invalid'),
        contributes: { locales: [{ label: 'x' }, { locale: 'es' }] }
      })

      loader.loadContributions(manifestPath, 'builtin')

      expect(languagePackRegistry.getAll()).toEqual([])
    })

    it('label 缺失时回落成 locale 本身（至少还能选）', () => {
      const manifestPath = fixture.plugin(
        'p-nolabel',
        localeManifest('p.nolabel', 'ja', 'locales/ja.json')
      )
      fixture.write('p-nolabel/locales/ja.json', { 'host.diff.close': '閉じる' })

      loader.loadContributions(manifestPath, 'builtin')

      expect(languagePackRegistry.getAll()[0].label).toBe('ja')
    })

    it('unload 后语言包被摘除', () => {
      const manifestPath = fixture.plugin(
        'p-unload',
        localeManifest('p.unload', 'ko', 'locales/ko.json', '한국어')
      )
      fixture.write('p-unload/locales/ko.json', { 'host.diff.close': '닫기' })

      const manifest = loader.loadContributions(manifestPath, 'builtin')
      expect(languagePackRegistry.getAll()).toHaveLength(1)

      loader.unload(manifest!.id)
      expect(languagePackRegistry.getAll()).toEqual([])
    })
  })

  describe('manifest 文案（package.nls*.json）', () => {
    it('读入默认表与各语言表，并按 locale 解析 %key%', () => {
      const manifestPath = fixture.plugin('p-nls', viewManifest('p.nls', '%v.title%'))
      fixture.write('p-nls/package.nls.json', { 'v.title': '默认标题' })
      fixture.write('p-nls/package.nls.en-US.json', { 'v.title': 'English title' })

      loader.loadContributions(manifestPath, 'builtin')

      expect(manifestNlsRegistry.resolve('p.nls', '%v.title%', 'en-US')).toBe('English title')
      expect(manifestNlsRegistry.resolve('p.nls', '%v.title%', 'zh-CN')).toBe('默认标题')
    })

    it('词条文件名里的大小写不影响匹配', () => {
      const manifestPath = fixture.plugin('p-case', viewManifest('p.case', '%v.title%'))
      fixture.write('p-case/package.nls.zh-cn.json', { 'v.title': '小写文件名' })

      loader.loadContributions(manifestPath, 'builtin')

      expect(manifestNlsRegistry.resolve('p.case', '%v.title%', 'zh-CN')).toBe('小写文件名')
    })

    it('占位符在任何词条文件里都不存在时报错，避免界面出现乱码', () => {
      const manifestPath = fixture.plugin('p-dangling', viewManifest('p.dangling', '%nope%'))

      loader.loadContributions(manifestPath, 'builtin')

      const [entry] = logger.calls.filter(([level]) => level === 'error')
      expect(entry?.[1]).toContain('%nope%')
    })

    it('用了占位符却完全没有词条文件时也报错', () => {
      const manifestPath = fixture.plugin('p-bare', viewManifest('p.bare', '%v.title%'))

      loader.loadContributions(manifestPath, 'builtin')

      const [entry] = logger.calls.filter(([level]) => level === 'error')
      expect(entry?.[1]).toContain('%v.title%')
    })

    it('普通字符串标题不触发任何告警', () => {
      const manifestPath = fixture.plugin('p-plain', viewManifest('p.plain', '普通标题'))

      loader.loadContributions(manifestPath, 'builtin')

      expect(logger.calls.filter(([level]) => level === 'error')).toEqual([])
    })

    it('unload 时 manifest 词条一并摘除', () => {
      const manifestPath = fixture.plugin('p-nls-unload', viewManifest('p.nlsUnload', '%v.title%'))
      fixture.write('p-nls-unload/package.nls.json', { 'v.title': '标题' })

      const manifest = loader.loadContributions(manifestPath, 'builtin')
      expect(manifestNlsRegistry.resolve('p.nlsUnload', '%v.title%', 'zh-CN')).toBe('标题')

      loader.unload(manifest!.id)
      expect(manifestNlsRegistry.resolve('p.nlsUnload', '%v.title%', 'zh-CN')).toBe('%v.title%')
    })
  })
})
