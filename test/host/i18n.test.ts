import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HostI18n,
  LanguagePackRegistry,
  resolvePluginTitle
} from '../../packages/host/src/services/i18n.ts'
import type { LanguagePackEntry } from '../../packages/host/src/services/i18n.ts'
import { parsePlaceholder } from '../../packages/contracts/src/plugin-api/manifest-nls.ts'
import type { PluginManifestNls } from '../../packages/contracts/src/plugin-api/contributions.ts'

/**
 * host 侧的本地化：语言包注册表 + 逐 key 瀑布 + manifest 文案解析 + 偏好。
 *
 * 这一整块从 shell 搬过来（原来在 `src/main/i18n`），搬迁时逐条保留了行为，
 * 所以这里覆盖的仍是同一批承诺：第三方优先、缺的往下降级、conflict 只记输家、
 * missing / extra 的诊断，以及「中文永远可选」。
 */

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
      source: 'third-party',
      locale: 'en-US'
    })
  })

  it('冲突的输家是内置', () => {
    expect(resolved.diagnostics.conflicts[0].loser).toEqual({
      pluginId: 'builtin.lang-en',
      source: 'builtin',
      locale: 'en-US'
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

describe('逐 key 瀑布：第三方优先，缺的往下降级', () => {
  /**
   * 用户的原始诉求，直接编码成用例：
   *
   *   第三方 A：a -> a1（没翻 b、c）
   *   第三方 B：a -> a2, b -> b2（没翻 c）
   *   内置：    a -> a3, b -> b3, c -> c3
   *
   * 期望 a1 / b2 / c3 —— 每个 key 各自沿链找**第一个**提供的包，
   * 而不是「谁兜底谁说了算」或「整份包覆盖」。
   */
  function waterfallRegistry(): LanguagePackRegistry {
    const registry = new LanguagePackRegistry()
    // 刻意打乱注册顺序：结果必须只由 tier + pluginId 决定
    registry.register(
      pack({
        locale: 'en-US',
        source: 'builtin',
        pluginId: 'builtin.lang-en',
        messages: { a: 'a3', b: 'b3', c: 'c3' }
      })
    )
    registry.register(
      pack({
        locale: 'en-US',
        source: 'third-party',
        pluginId: 'vendor.b',
        messages: { a: 'a2', b: 'b2' }
      })
    )
    registry.register(
      pack({
        locale: 'en-US',
        source: 'third-party',
        pluginId: 'vendor.a',
        messages: { a: 'a1' }
      })
    )
    return registry
  }

  const resolved = waterfallRegistry().buildMessages('en-US')

  it('每个 key 取链上第一个提供的包：a1 / b2 / c3', () => {
    expect(resolved.messages.a).toBe('a1')
    expect(resolved.messages.b).toBe('b2')
    expect(resolved.messages.c).toBe('c3')
  })

  it('chosen provider 是逐 key 记录的，不是整 locale 一个', () => {
    const providers = resolved.diagnostics.providers
    expect(providers.a).toEqual({ pluginId: 'vendor.a', source: 'third-party', locale: 'en-US' })
    expect(providers.b).toEqual({ pluginId: 'vendor.b', source: 'third-party', locale: 'en-US' })
    expect(providers.c).toEqual({
      pluginId: 'builtin.lang-en',
      source: 'builtin',
      locale: 'en-US'
    })
  })

  it('冲突只记「被压下去」的那一份，赢家始终是链上第一个', () => {
    // a 被三个包提供 -> 记两条（vendor.a 压 vendor.b、vendor.a 压内置）
    // b 被两个包提供 -> 记一条；c 只有内置翻 -> 不算冲突
    expect(resolved.diagnostics.conflicts.map((c) => `${c.key}:${c.loser.pluginId}`)).toEqual([
      'a:vendor.b',
      'a:builtin.lang-en',
      'b:builtin.lang-en'
    ])
    for (const conflict of resolved.diagnostics.conflicts) {
      expect(conflict.winner.pluginId).toBe(conflict.key === 'b' ? 'vendor.b' : 'vendor.a')
    }
  })

  it('同 tier 内按 pluginId 字典序，与注册顺序无关', () => {
    // 把注册顺序整个倒过来：链的排序只看 tier + pluginId，答案必须一模一样
    const reversed = new LanguagePackRegistry()
    for (const entry of [...waterfallRegistry().getAll()].reverse()) reversed.register(entry)

    const other = reversed.buildMessages('en-US')
    expect(other.messages.a).toBe('a1')
    expect(other.messages.b).toBe('b2')
    expect(other.messages.c).toBe('c3')
    expect(other.diagnostics.providers).toEqual(resolved.diagnostics.providers)
  })

  it('冲突的赢家是链上更靠前的那个包', () => {
    const conflict = resolved.diagnostics.conflicts.find((c) => c.key === 'b')
    expect(conflict?.winner).toEqual({
      pluginId: 'vendor.b',
      source: 'third-party',
      locale: 'en-US'
    })
    expect(conflict?.loser).toEqual({
      pluginId: 'builtin.lang-en',
      source: 'builtin',
      locale: 'en-US'
    })
  })

  it('没被任何包提供的 key 才算 missing（落回中文基础表）', () => {
    // a/b/c 都是自造 key，不在宿主基础表里 —— 这份表只用来验证 provider 归属
    expect(resolved.diagnostics.extra.sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('跨 locale 的瀑布：en-GB 请求吃 en 包', () => {
  // en-US 包**够不着** en-GB 的候选链（["en-GB", "en"]），所以这里不注册它 ——
  // 语言变体之间不互相兜底，只有「地区 -> 语言」这一层放宽
  const registry = new LanguagePackRegistry()
  registry.register(
    pack({
      locale: 'en',
      source: 'builtin',
      pluginId: 'builtin.lang-en',
      messages: { 'host.diff.close': 'Wide close', 'host.diff.title': 'Wide title' }
    })
  )
  registry.register(
    pack({
      locale: 'en',
      source: 'third-party',
      pluginId: 'vendor.en',
      messages: { 'host.diff.close': 'Community close' }
    })
  )

  const resolved = registry.buildMessages('en-GB')

  it('宽泛 locale 的包能被具体 locale 的请求接住', () => {
    expect(resolved.messages['host.diff.title']).toBe('Wide title')
  })

  it('同一宽泛 locale 下仍逐 key 瀑布：没翻的落到内置包', () => {
    expect(resolved.messages['host.diff.close']).toBe('Community close')
  })

  it('provider 里能看到实际生效的是宽泛的 en 包', () => {
    expect(resolved.diagnostics.providers['host.diff.title']).toEqual({
      pluginId: 'builtin.lang-en',
      source: 'builtin',
      locale: 'en'
    })
  })

  it('链上一个包都没有的 key 仍落回中文基础表', () => {
    expect(resolved.messages['host.locale.switch.cancel']).toBe('取消')
  })

  it('tier 是外层排序键：宽泛 locale 的第三方包仍压过更具体的内置包', () => {
    const r = new LanguagePackRegistry()
    r.register(
      pack({
        locale: 'en-GB',
        source: 'builtin',
        pluginId: 'builtin.lang-en-gb',
        messages: { k: 'builtin-gb' }
      })
    )
    r.register(
      pack({
        locale: 'en',
        source: 'third-party',
        pluginId: 'vendor.en',
        messages: { k: 'third-party-wide' }
      })
    )
    // 「第三方优先」优先于「locale 具体优先」；locale 具体度只在同 tier 内比较
    expect(r.buildMessages('en-GB').messages.k).toBe('third-party-wide')
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
  const nls: PluginManifestNls = {
    defaultTable: { 'demo.a': '默认中文A', 'demo.onlyDefault': '只有默认表有' },
    byLocale: {
      'en-US': { 'demo.a': 'English A', 'demo.b': 'English B' },
      en: { 'demo.b': 'Wide English B' }
    }
  }

  it('普通字符串原样返回 —— 老插件不用改 manifest', () => {
    expect(resolvePluginTitle(nls, '普通标题', 'en-US')).toBe('普通标题')
  })

  it('整串 %key% 按当前语言解析', () => {
    expect(resolvePluginTitle(nls, '%demo.a%', 'en-US')).toBe('English A')
  })

  it('精确 locale 优先于放宽', () => {
    expect(resolvePluginTitle(nls, '%demo.b%', 'en-US')).toBe('English B')
  })

  it('locale 放宽：en-GB 命中 en 表', () => {
    expect(resolvePluginTitle(nls, '%demo.b%', 'en-GB')).toBe('Wide English B')
  })

  it('该语言没翻时回落插件默认表', () => {
    expect(resolvePluginTitle(nls, '%demo.onlyDefault%', 'en-US')).toBe('只有默认表有')
  })

  it('当前语言与默认表都没有时保留原样占位符，让漏翻可见', () => {
    expect(resolvePluginTitle(nls, '%demo.b%', 'zh-CN')).toBe('%demo.b%')
  })

  it('key 在任何表里都没有时保留原样占位符', () => {
    expect(resolvePluginTitle(nls, '%demo.missing%', 'en-US')).toBe('%demo.missing%')
  })

  it('没有词条表的插件保留原样占位符', () => {
    expect(resolvePluginTitle(undefined, '%demo.a%', 'en-US')).toBe('%demo.a%')
  })

  it('只有整串被 % 包住才算占位符', () => {
    expect(parsePlaceholder('100% done')).toBeNull()
    expect(parsePlaceholder('%a')).toBeNull()
    expect(parsePlaceholder('%a%')).toBe('a')
  })
})

describe('HostI18n：偏好与切换', () => {
  let base = ''
  let userDataDir = ''

  function service(): HostI18n {
    return new HostI18n({ userDataDir })
  }

  /** 一个最小的英文包 */
  function withEnglish(i18n: HostI18n): HostI18n {
    i18n.setPacks([
      {
        locale: 'en-US',
        label: 'English',
        source: 'builtin',
        pluginId: 'builtin.lang-en',
        dir: 'lang-en',
        messages: { 'host.diff.close': 'Close' }
      }
    ])
    return i18n
  }

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'nide-i18n-'))
    userDataDir = path.join(base, 'user-data')
    await fs.mkdir(userDataDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true })
  })

  it('没有偏好、系统语言也没有包时回落中文，中文永远可选', () => {
    const payload = withEnglish(service()).init(['ja-JP'])

    expect(payload.locale).toBe('zh-CN')
    expect(payload.fallbackFrom).toBe('ja-JP')
    // 按 label 用 zh-CN 排序：中文排在英文前面（Han 在 Latin 之前）
    expect(payload.available.map((d) => d.locale)).toEqual(['zh-CN', 'en-US'])
    expect(payload.messages['host.diff.close']).toBe('关闭')
  })

  it('偏好优先于系统语言', async () => {
    await fs.writeFile(path.join(userDataDir, 'locale.json'), '{"locale":"en-US"}', 'utf-8')

    const payload = withEnglish(service()).init(['zh-CN'])

    expect(payload.locale).toBe('en-US')
    expect(payload.messages['host.diff.close']).toBe('Close')
  })

  it('系统语言命中语言包时直接用它（地区可放宽）', () => {
    const i18n = service()
    // 只装了宽泛的 en 包：请求 en-GB 时应当命中它，并把「实际生效的」en 报回来
    i18n.setPacks([
      {
        locale: 'en',
        label: 'English',
        source: 'builtin',
        pluginId: 'builtin.lang-en',
        dir: 'lang-en',
        messages: {}
      }
    ])

    expect(i18n.init(['en-GB']).locale).toBe('en')
  })

  it('setLocale 落盘，下一次启动读回来', async () => {
    const i18n = withEnglish(service())
    i18n.init([])

    expect(i18n.setLocale('en-US')?.locale).toBe('en-US')

    const stored = await fs.readFile(path.join(userDataDir, 'locale.json'), 'utf-8')
    expect(JSON.parse(stored)).toEqual({ locale: 'en-US' })
    expect(withEnglish(service()).init([]).locale).toBe('en-US')
  })

  it('setLocale 对没有语言包的 locale 返回 null，且不改偏好', async () => {
    const i18n = withEnglish(service())
    i18n.init([])

    expect(i18n.setLocale('ja-JP')).toBeNull()

    await expect(fs.readFile(path.join(userDataDir, 'locale.json'))).rejects.toThrow()
  })

  it('损坏的偏好文件当作没有偏好', async () => {
    await fs.writeFile(path.join(userDataDir, 'locale.json'), '{ not json', 'utf-8')

    expect(withEnglish(service()).init(['en-US']).locale).toBe('en-US')
  })

  it('setPacks 之后切换才会认新装的语言包', () => {
    const i18n = service()
    i18n.init([])
    expect(i18n.setLocale('en-US')).toBeNull()

    i18n.setPacks([
      {
        locale: 'en-US',
        label: 'English',
        source: 'builtin',
        pluginId: 'builtin.lang-en',
        dir: 'lang-en',
        messages: {}
      }
    ])

    expect(i18n.setLocale('en-US')?.locale).toBe('en-US')
  })
})
