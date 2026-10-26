import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readPluginContributions,
  setContributionsLogger
} from '../../packages/host/src/services/plugin-contributions.ts'
import type {
  ContributionsLogger,
  PluginContributionSet
} from '../../packages/host/src/services/plugin-contributions.ts'
import { isReservedHostId } from '../../packages/contracts/src/plugin-api/view.ts'
import {
  createPluginFixture,
  localeManifest,
  manifestShell,
  type PluginFixture
} from '../fixtures/plugin-fixture'

/**
 * 插件贡献点的读取（视图 / 设置页 / 语言包 / manifest 词条）。
 *
 * 这一层是**唯一**读插件目录的地方（此前 shell 的 loader 与 host 的清单扫描各读一遍），
 * 所以这里撞的是它的全部收敛规则：路径不可信、坏一项不带走整份、保留 id 整份拒绝。
 *
 * 全部用真的临时目录 —— 这个模块就是碰盘的，mock 掉 fs 等于把它测成另一段代码。
 */

/** 记录调用的 logger 假件：既不刷屏，又能断言「有没有报警」 */
function spyLogger(): ContributionsLogger & { calls: Array<[string, string, unknown]> } {
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
    debug: record('debug')
  }
}

/** 造一个只贡献单个视图的 manifest，chrome 由调用方给 */
function viewManifest(chrome: unknown): unknown {
  return {
    ...manifestShell('builtin.chrome-test'),
    contributes: {
      views: [
        {
          id: 'chrome.view',
          title: '外壳测试',
          location: 'rightTop',
          entry: 'src/ui/index.tsx',
          chrome
        }
      ]
    }
  }
}

/** 造一个贡献单个视图的 manifest（标题由调用方给） */
function titledViewManifest(id: string, title: string): unknown {
  return {
    ...manifestShell(id),
    contributes: {
      views: [{ id: `${id}.view`, title, location: 'rightTop', entry: 'src/ui/index.tsx' }]
    }
  }
}

let fixture: PluginFixture
let logger: ReturnType<typeof spyLogger>

/** 按 PluginManager 的方式读一份 manifest 的贡献点 */
function read(
  manifestPath: string,
  source: 'builtin' | 'third-party' = 'builtin'
): PluginContributionSet | null {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
    id?: string
    contributes?: unknown
  }

  return readPluginContributions({
    pluginDir: path.dirname(manifestPath),
    pluginId: String(manifest.id ?? ''),
    source,
    contributes: manifest.contributes
  })
}

beforeEach(() => {
  fixture = createPluginFixture()
  logger = spyLogger()
  setContributionsLogger(logger)
})

afterEach(() => {
  fixture.remove()
  vi.restoreAllMocks()
})

function errors(): Array<[string, string, unknown]> {
  return logger.calls.filter(([level]) => level === 'error')
}

describe('视图贡献', () => {
  it('没有声明 chrome 时不落任何字段，由渲染进程用默认值（全开）', () => {
    const contributions = read(fixture.plugin('no-chrome', viewManifest(undefined)))

    expect(contributions?.views[0]?.chrome).toBeUndefined()
  })

  it('合法声明原样落到贡献点', () => {
    const contributions = read(
      fixture.plugin('with-chrome', viewManifest({ title: false, minimize: false, tabs: true }))
    )

    expect(contributions?.views[0]?.chrome).toEqual({
      title: false,
      minimize: false,
      tabs: true
    })
  })

  it('非布尔值的那一项被丢掉，同一份声明里其余项照常生效', () => {
    const contributions = read(
      fixture.plugin('bad-flag', viewManifest({ title: 'false', minimize: false }))
    )

    // 'false' 不是布尔，丢掉它 —— 视图因此拿到默认的 title: true
    expect(contributions?.views[0]?.chrome).toEqual({ minimize: false })
    expect(
      logger.calls.some(
        ([level, , fields]) =>
          level === 'warn' && (fields as { flag?: string } | undefined)?.flag === 'title'
      )
    ).toBe(true)
  })

  it('chrome 整个写成非对象时忽略它，视图照常出现', () => {
    const contributions = read(fixture.plugin('not-object', viewManifest('header')))

    expect(contributions?.views[0]?.chrome).toBeUndefined()
    // 视图本身必须还在：外壳声明写坏不该让插件从工具区里消失
    expect(contributions?.views[0]?.titleSpec).toBe('外壳测试')
    expect(logger.calls.some(([level]) => level === 'warn')).toBe(true)
  })

  it('不认识的开关被静默忽略（只认那五个字段）', () => {
    const contributions = read(
      fixture.plugin('unknown-flag', viewManifest({ minimize: false, ttile: true }))
    )

    expect(contributions?.views[0]?.chrome).toEqual({ minimize: false })
  })

  it('入口按插件目录相对化，标题缺省时回落成视图 id', () => {
    const contributions = read(
      fixture.plugin('entry', {
        ...manifestShell('p.entry'),
        contributes: {
          views: [{ id: 'p.entry.view', location: 'leftTop' }]
        }
      })
    )

    const view = contributions?.views[0]
    expect(view?.titleSpec).toBe('p.entry.view')
    expect(view?.entry).toBe('src/ui/index.tsx')
    expect(view?.entry.includes('\\')).toBe(false)
    expect(view?.dir).toBe('entry')
    expect(view?.pluginId).toBe('p.entry')
  })

  it('旧 location 映射到新位置，不认识的值回落并告警', () => {
    const contributions = read(
      fixture.plugin('locations', {
        ...manifestShell('p.loc'),
        contributes: {
          views: [
            { id: 'p.loc.sidebar', location: 'sidebar' },
            { id: 'p.loc.panel', location: 'panel' },
            { id: 'p.loc.bad', location: 'nope' }
          ]
        }
      })
    )

    expect(contributions?.views.map((view) => view.location)).toEqual([
      'rightTop',
      'bottomLeft',
      'rightTop'
    ])
    // 两条 legacy 映射各告警一次，加一条不认识的值回落 —— 三条都是 warn
    expect(logger.calls.filter(([level]) => level === 'warn')).toHaveLength(3)
  })
})

describe('宿主保留 id 空间', () => {
  it('内建视图 id 与 HOST_VIEW_PLUGIN_ID 本身算越界', () => {
    expect(isReservedHostId('host')).toBe(true)
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

  it('插件 id 占用 host 命名空间时整份被拒绝（连语言包一起）', () => {
    const manifestPath = fixture.plugin(
      'evil',
      localeManifest('host', 'en-US', 'locales/en-US.json', 'English')
    )
    fixture.write('evil/locales/en-US.json', { 'host.diff.close': 'LEAKED' })

    expect(read(manifestPath, 'third-party')).toBeNull()
    expect(errors()).toHaveLength(1)
  })

  it('插件 id 取内建视图名（host.git）同样被拒绝', () => {
    expect(
      read(fixture.plugin('evil-git', titledViewManifest('host.git', 'x')), 'third-party')
    ).toBeNull()
  })

  it('视图 id 占用保留空间时只跳过这一个视图，插件其余部分照常', () => {
    const contributions = read(
      fixture.plugin('p-viewid', {
        ...manifestShell('p.viewid'),
        contributes: {
          views: [
            { id: 'host.git', title: '冒名顶替', location: 'bottomLeft', entry: 'src/ui/a.tsx' },
            { id: 'p.viewid.ok', title: '正常视图', location: 'rightTop', entry: 'src/ui/b.tsx' }
          ]
        }
      }),
      'third-party'
    )

    expect(contributions?.views.map((view) => view.id)).toEqual(['p.viewid.ok'])
    expect(errors()).toHaveLength(1)
  })

  it('合法的插件 id 与视图 id 不受影响', () => {
    const contributions = read(
      fixture.plugin('p-ok', titledViewManifest('p.ok', '正常')),
      'third-party'
    )

    expect(contributions?.views.map((view) => view.id)).toEqual(['p.ok.view'])
    expect(errors()).toEqual([])
  })
})

describe('设置页贡献', () => {
  it('默认入口 src/settings/index.tsx，order 缺省为 0', () => {
    const manifestPath = fixture.plugin('p-settings', {
      ...manifestShell('p.settings'),
      contributes: { settings: [{ id: 'general', title: '常规' }] }
    })
    fixture.write('p-settings/src/settings/index.tsx', '// entry')

    const settings = read(manifestPath)?.settings ?? []
    expect(settings).toEqual([
      {
        id: 'general',
        pluginId: 'p.settings',
        titleSpec: '常规',
        dir: 'p-settings',
        entry: 'src/settings/index.tsx',
        order: 0
      }
    ])
  })

  it('自定义入口与 order 原样保留', () => {
    const manifestPath = fixture.plugin('p-custom', {
      ...manifestShell('p.custom'),
      contributes: {
        settings: [{ id: 'x', title: 'X', entry: 'src/settings/x.tsx', order: 5 }]
      }
    })
    fixture.write('p-custom/src/settings/x.tsx', '// entry')

    expect(read(manifestPath)?.settings[0]).toMatchObject({
      entry: 'src/settings/x.tsx',
      order: 5
    })
  })

  it('入口文件不存在时跳过该页并报错', () => {
    const manifestPath = fixture.plugin('p-missing', {
      ...manifestShell('p.missing'),
      contributes: { settings: [{ id: 'x' }] }
    })

    expect(read(manifestPath)?.settings).toEqual([])
    expect(errors().some(([, text]) => text.includes('Settings page entry not found'))).toBe(true)
  })

  it('入口跑出插件目录时跳过（../）', () => {
    fixture.write('outside/settings.tsx', '// entry')
    const manifestPath = fixture.plugin('p-trav', {
      ...manifestShell('p.trav'),
      contributes: { settings: [{ id: 'x', entry: '../../outside/settings.tsx' }] }
    })

    expect(read(manifestPath)?.settings).toEqual([])
  })

  it('设置页 id 占用保留空间时跳过', () => {
    const manifestPath = fixture.plugin('p-hostid', {
      ...manifestShell('p.hostid'),
      contributes: { settings: [{ id: 'host.settings' }] }
    })
    fixture.write('p-hostid/src/settings/index.tsx', '// entry')

    expect(read(manifestPath)?.settings).toEqual([])
    expect(errors()).toHaveLength(1)
  })

  it('条目不是对象时跳过，不影响同一份声明里的其他页', () => {
    const manifestPath = fixture.plugin('p-junk', {
      ...manifestShell('p.junk'),
      contributes: { settings: ['nope', { id: 'ok', title: 'OK' }] }
    })
    fixture.write('p-junk/src/settings/index.tsx', '// entry')

    expect(read(manifestPath)?.settings.map((page) => page.id)).toEqual(['ok'])
  })
})

describe('语言包贡献', () => {
  it('纯数据插件（没有 views）也能读', () => {
    const manifestPath = fixture.plugin(
      'p-ok',
      localeManifest('p.ok', 'en-US', 'locales/en-US.json', 'English')
    )
    fixture.write('p-ok/locales/en-US.json', { 'host.diff.close': 'Close' })

    expect(read(manifestPath)?.locales).toHaveLength(1)
  })

  it('locale 被规范化，来源层级透传，dir 取自插件目录名', () => {
    const manifestPath = fixture.plugin(
      'p-ok',
      localeManifest('p.ok', 'en-us', 'locales/x.json', 'English')
    )
    fixture.write('p-ok/locales/x.json', { 'host.diff.close': 'Close' })

    const [pack] = read(manifestPath, 'third-party')?.locales ?? []
    expect(pack.locale).toBe('en-US')
    expect(pack.source).toBe('third-party')
    expect(pack.dir).toBe('p-ok')
    expect(pack.messages).toEqual({ 'host.diff.close': 'Close' })
  })

  it('拒绝 ../ 路径穿越（目标文件真实存在，证明是守卫拦下的）', () => {
    fixture.write('outside.json', { 'host.diff.close': 'LEAKED' })
    const manifestPath = fixture.plugin(
      'p-trav',
      localeManifest('p.trav', 'en-US', '../outside.json', 'x')
    )

    expect(read(manifestPath)?.locales).toEqual([])
  })

  it('拒绝绝对路径', () => {
    const absolute = fixture.write('outside.json', { 'host.diff.close': 'LEAKED' })
    const manifestPath = fixture.plugin('p-abs', localeManifest('p.abs', 'en-US', absolute, 'x'))

    expect(read(manifestPath)?.locales).toEqual([])
  })

  it('文件缺失时只跳过、不抛异常', () => {
    const manifestPath = fixture.plugin(
      'p-missing',
      localeManifest('p.missing', 'en-US', 'locales/nope.json', 'x')
    )

    expect(() => read(manifestPath)).not.toThrow()
    expect(read(manifestPath)?.locales).toEqual([])
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

    expect(Object.keys(read(manifestPath)?.locales[0]?.messages ?? {})).toEqual(['host.diff.close'])
  })

  it('顶层是数组时拒绝', () => {
    const manifestPath = fixture.plugin(
      'p-array',
      localeManifest('p.array', 'fr', 'locales/fr.json', 'x')
    )
    fixture.write('p-array/locales/fr.json', '["a","b"]')

    expect(read(manifestPath)?.locales).toEqual([])
  })

  it('坏 JSON 只丢这一个包、不抛异常', () => {
    const manifestPath = fixture.plugin(
      'p-broken',
      localeManifest('p.broken', 'it', 'locales/it.json', 'x')
    )
    fixture.write('p-broken/locales/it.json', '{ not json')

    expect(() => read(manifestPath)).not.toThrow()
    expect(read(manifestPath)?.locales).toEqual([])
  })

  it('缺 locale/file 的条目被跳过', () => {
    const manifestPath = fixture.plugin('p-invalid', {
      ...manifestShell('p.invalid'),
      contributes: { locales: [{ label: 'x' }, { locale: 'es' }] }
    })

    expect(read(manifestPath)?.locales).toEqual([])
  })

  it('label 缺失时回落成 locale 本身（至少还能选）', () => {
    const manifestPath = fixture.plugin(
      'p-nolabel',
      localeManifest('p.nolabel', 'ja', 'locales/ja.json')
    )
    fixture.write('p-nolabel/locales/ja.json', { 'host.diff.close': '閉じる' })

    expect(read(manifestPath)?.locales[0]?.label).toBe('ja')
  })
})

describe('manifest 文案（package.nls*.json）', () => {
  it('读入默认表与各语言表，locale 键规范化', () => {
    const manifestPath = fixture.plugin('p-nls', titledViewManifest('p.nls', '%v.title%'))
    fixture.write('p-nls/package.nls.json', { 'v.title': '默认标题' })
    fixture.write('p-nls/package.nls.zh-cn.json', { 'v.title': '小写文件名' })

    const nls = read(manifestPath)?.manifestNls
    expect(nls?.defaultTable).toEqual({ 'v.title': '默认标题' })
    expect(nls?.byLocale['zh-CN']).toEqual({ 'v.title': '小写文件名' })
  })

  it('没有词条文件时不给表（插件没做本地化是合法的）', () => {
    const manifestPath = fixture.plugin('p-bare', titledViewManifest('p.bare', '普通标题'))

    expect(read(manifestPath)?.manifestNls).toBeUndefined()
  })

  it('占位符在任何词条文件里都不存在时报错，避免界面出现乱码', () => {
    read(fixture.plugin('p-dangling', titledViewManifest('p.dangling', '%nope%')))

    const [entry] = errors()
    expect(entry?.[1]).toContain('%nope%')
  })

  it('用了占位符却完全没有词条文件时也报错', () => {
    read(fixture.plugin('p-missing-nls', titledViewManifest('p.missingNls', '%v.title%')))

    const [entry] = errors()
    expect(entry?.[1]).toContain('%v.title%')
  })

  it('普通字符串标题不触发任何告警', () => {
    read(fixture.plugin('p-plain', titledViewManifest('p.plain', '普通标题')))

    expect(errors()).toEqual([])
  })
})
