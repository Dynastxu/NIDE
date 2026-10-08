import { describe, expect, it } from 'vitest'
import {
  createLooseTranslator,
  createTranslator,
  interpolate,
  localeCandidates,
  normalizeLocale,
  toMonacoLocale
} from '@shared/i18n'
import { LanguagePackRegistry } from '../src/main/i18n/language-packs'
import { ManifestNlsRegistry, parsePlaceholder } from '../src/main/i18n/manifest-nls'
import type { LanguagePackEntry } from '../src/main/i18n'

/** 造一条语言包记录，只写关心的字段 */
function pack(
  partial: Partial<LanguagePackEntry> & Pick<LanguagePackEntry, 'locale' | 'source' | 'pluginId'>
): LanguagePackEntry {
  return {
    label: partial.locale,
    dir: partial.pluginId,
    messages: {},
    ...partial
  }
}

describe('locale 规范化', () => {
  it('把下划线转成连字符并收敛大小写', () => {
    expect(normalizeLocale('zh_hans_cn')).toBe('zh-Hans-CN')
  })

  it('语言小写、地区大写', () => {
    expect(normalizeLocale('EN_us')).toBe('en-US')
  })

  it('空串回落到默认 locale', () => {
    expect(normalizeLocale('')).toBe('zh-CN')
  })
})

describe('locale 候选链', () => {
  it('由具体到宽泛', () => {
    expect(localeCandidates('zh-Hans-CN')).toEqual(['zh-Hans-CN', 'zh-Hans', 'zh'])
  })
})

describe('Monaco locale 映射', () => {
  // Monaco 的文件名是小写，项目内部是 BCP-47，这层映射是必要的翻译
  it('zh-CN 映射成 zh-cn', () => {
    expect(toMonacoLocale('zh-CN')).toBe('zh-cn')
  })

  it('zh-TW 映射成 zh-tw', () => {
    expect(toMonacoLocale('zh-TW')).toBe('zh-tw')
  })

  it('zh-Hant 走繁体', () => {
    expect(toMonacoLocale('zh-Hant')).toBe('zh-tw')
  })

  it('英文返回 null —— Monaco 的英文是内建默认，不存在语言文件', () => {
    expect(toMonacoLocale('en-US')).toBeNull()
  })

  it('不认识的语言返回 null', () => {
    expect(toMonacoLocale('xx-YY')).toBeNull()
  })
})

describe('插值', () => {
  it('按 {name} 替换', () => {
    expect(interpolate('已点击 {count} 次', { count: 3 })).toBe('已点击 3 次')
  })

  it('缺参数时保留占位符，便于一眼看出漏传', () => {
    expect(interpolate('{a}-{b}', { a: 1 })).toBe('1-{b}')
  })

  it('不传参数时原样返回', () => {
    expect(interpolate('原样')).toBe('原样')
  })
})

describe('宿主 t()', () => {
  it('词条表里没有时回落中文基础表', () => {
    expect(createTranslator({})('host.diff.close')).toBe('关闭')
  })

  it('只接受宿主命名空间的 key', () => {
    // 传 'k' 这类 key 会触发 TS2345 —— 那条类型约束就是宿主代码的安全网，
    // 这里只能断言运行时行为，编译期那半由 tsc 保证
    expect(createTranslator({ 'host.diff.close': 'Close' })('host.diff.close')).toBe('Close')
  })

  it('走的是同一套插值', () => {
    expect(createTranslator({ 'host.diff.close': '{a} 条' })('host.diff.close', { a: 7 })).toBe(
      '7 条'
    )
  })
})

describe('插件的 t()', () => {
  it('key 放宽成任意字符串', () => {
    expect(createLooseTranslator({ k: '已点击 {count} 次' })('k', { count: 2 })).toBe('已点击 2 次')
  })

  it('漏翻时原样给出 key，而不是回落到宿主中文', () => {
    // 回落成宿主中文只会掩盖"这个插件漏翻"，还会造成中英混排
    expect(createLooseTranslator({ k: 'x' })('missing')).toBe('missing')
  })
})

describe('语言包合并与优先级', () => {
  // 刻意把第三方**先**注册、内置**后**注册：优先级必须靠 tier 而不是加载顺序
  const registry = new LanguagePackRegistry()
  registry.register(
    pack({
      locale: 'en-US',
      label: 'English (community)',
      source: 'third-party',
      pluginId: 'user.lang-en',
      messages: { 'host.diff.close': 'Dismiss', 'host.locale.switch.cancel': 'Never mind' }
    })
  )
  registry.register(
    pack({
      locale: 'en-US',
      label: 'English',
      source: 'builtin',
      pluginId: 'builtin.lang-en',
      messages: { 'host.diff.close': 'Close', 'host.diff.title': 'Diff comparison' }
    })
  )
  const resolved = registry.buildMessages('en-US')

  it('第三方覆盖内置（即使第三方先注册）', () => {
    expect(resolved.messages['host.diff.close']).toBe('Dismiss')
  })

  it('内置在第三方未提供的 key 上仍然生效', () => {
    expect(resolved.messages['host.diff.title']).toBe('Diff comparison')
  })

  it('都没提供的 key 回落中文基础表', () => {
    expect(resolved.messages['host.app.title']).toBe('NIDE')
  })

  it('记录冲突，赢家是第三方', () => {
    expect(resolved.diagnostics.conflicts).toHaveLength(1)
    expect(resolved.diagnostics.conflicts[0].winner).toEqual({
      pluginId: 'user.lang-en',
      source: 'third-party'
    })
  })

  it('冲突的输家是内置', () => {
    expect(resolved.diagnostics.conflicts[0].loser).toEqual({
      pluginId: 'builtin.lang-en',
      source: 'builtin'
    })
  })

  it('missing 只含未翻译的 key', () => {
    expect(resolved.diagnostics.missing).toContain('host.app.title')
    expect(resolved.diagnostics.missing).not.toContain('host.diff.close')
  })

  it('没有宿主不认识的 key', () => {
    expect(resolved.diagnostics.extra).toEqual([])
  })

  it('译文相同的重复提供不算冲突（避免淹没真问题）', () => {
    const same = new LanguagePackRegistry()
    same.register(
      pack({
        locale: 'de',
        source: 'builtin',
        pluginId: 'a',
        messages: { 'host.diff.close': 'Schließen' }
      })
    )
    same.register(
      pack({
        locale: 'de',
        source: 'third-party',
        pluginId: 'b',
        messages: { 'host.diff.close': 'Schließen' }
      })
    )
    expect(same.buildMessages('de').diagnostics.conflicts).toEqual([])
  })

  it('zh-CN 的 missing 恒为空 —— 基础表本身就是中文', () => {
    expect(registry.buildMessages('zh-CN').diagnostics.missing).toEqual([])
  })

  it('拼错的 key 被报为 extra', () => {
    const typo = new LanguagePackRegistry()
    typo.register(
      pack({ locale: 'fr', source: 'builtin', pluginId: 'c', messages: { 'host.typo.key': 'x' } })
    )
    expect(typo.buildMessages('fr').diagnostics.extra).toEqual(['host.typo.key'])
  })
})

describe('locale 匹配与语言列表', () => {
  const registry = new LanguagePackRegistry()
  registry.register(
    pack({
      locale: 'en-US',
      label: 'English (community)',
      source: 'third-party',
      pluginId: 'user.lang-en',
      messages: { 'host.diff.close': 'Dismiss' }
    })
  )
  registry.register(
    pack({ locale: 'en', label: 'English', source: 'builtin', pluginId: 'd', messages: {} })
  )
  registry.register(
    pack({ locale: 'pt-BR', label: 'Português', source: 'builtin', pluginId: 'e', messages: {} })
  )

  it('地区可放宽：en-GB 命中 en 包', () => {
    expect(registry.matchLocale('en-GB')).toBe('en')
  })

  it('精确命中优先', () => {
    expect(registry.matchLocale('en-US')).toBe('en-US')
  })

  it('大小写不敏感', () => {
    expect(registry.matchLocale('PT-br')).toBe('pt-BR')
  })

  it('一个候选都没有时返回 null', () => {
    expect(registry.matchLocale('ja-JP')).toBeNull()
  })

  it('同一 locale 只出现一条', () => {
    const enUs = registry.descriptors().filter((d) => d.locale === 'en-US')
    expect(enUs).toHaveLength(1)
  })

  it('展示的是实际生效（胜出）的那个包', () => {
    const descriptor = registry.descriptors().find((d) => d.locale === 'en-US')
    expect(descriptor?.label).toBe('English (community)')
  })
})

describe('插件 manifest 文案（%key% 解析）', () => {
  const nls = new ManifestNlsRegistry()
  nls.register('demo', {
    defaultTable: { 'demo.a': '默认中文A', 'demo.onlyDefault': '只有默认表有' },
    byLocale: {
      'en-US': { 'demo.a': 'English A', 'demo.b': 'English B' },
      en: { 'demo.b': 'Wide English B' }
    }
  })

  it('普通字符串原样返回 —— 老插件不用改 manifest', () => {
    expect(nls.resolve('demo', '普通标题', 'en-US')).toBe('普通标题')
  })

  it('undefined 保持 undefined', () => {
    expect(nls.resolve('demo', undefined, 'en-US')).toBeUndefined()
  })

  it('整串 %key% 按当前语言解析', () => {
    expect(nls.resolve('demo', '%demo.a%', 'en-US')).toBe('English A')
  })

  it('精确 locale 优先于放宽', () => {
    expect(nls.resolve('demo', '%demo.b%', 'en-US')).toBe('English B')
  })

  it('locale 放宽：en-GB 命中 en 表', () => {
    expect(nls.resolve('demo', '%demo.b%', 'en-GB')).toBe('Wide English B')
  })

  it('该语言没翻时回落插件默认表', () => {
    expect(nls.resolve('demo', '%demo.onlyDefault%', 'en-US')).toBe('只有默认表有')
  })

  it('当前语言与默认表都没有时保留原样占位符，让漏翻可见', () => {
    expect(nls.resolve('demo', '%demo.b%', 'zh-CN')).toBe('%demo.b%')
  })

  it('key 在任何表里都没有时保留原样占位符', () => {
    expect(nls.resolve('demo', '%demo.missing%', 'en-US')).toBe('%demo.missing%')
  })

  it('未注册的插件保留原样占位符', () => {
    expect(nls.resolve('nope', '%demo.a%', 'en-US')).toBe('%demo.a%')
  })

  it('只有整串被 % 包住才算占位符', () => {
    expect(parsePlaceholder('100% done')).toBeNull()
    expect(parsePlaceholder('%a')).toBeNull()
    expect(parsePlaceholder('%a%')).toBe('a')
  })

  it('unregisterByPlugin 后不再解析', () => {
    const scoped = new ManifestNlsRegistry()
    scoped.register('p', { byLocale: { 'en-US': { k: 'v' } } })
    expect(scoped.resolve('p', '%k%', 'en-US')).toBe('v')
    scoped.unregisterByPlugin('p')
    expect(scoped.resolve('p', '%k%', 'en-US')).toBe('%k%')
  })
})
