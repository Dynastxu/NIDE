import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_LOCALE,
  localeCandidates,
  normalizeLocale
} from '../../../../packages/contracts/src/i18n/locale-tag.ts'
import { TIER_PRIORITY } from '../../../../packages/contracts/src/i18n/types.ts'
import { zhCN } from '../../../../packages/contracts/src/i18n/locales/zh-CN.ts'
import { parsePlaceholder } from '../../../../packages/contracts/src/plugin-api/manifest-nls.ts'
import type {
  I18nPayload,
  LocaleConflict,
  LocaleDescriptor,
  LocaleId,
  LocaleProviderRef,
  LocaleSourceTier,
  MessageTable
} from '../../../../packages/contracts/src/i18n/types.ts'
import type {
  PluginLocalePack,
  PluginManifestNls
} from '../../../../packages/contracts/src/plugin-api/contributions.ts'

/**
 * 本地化（host 侧）：语言包注册表、语言偏好、载荷构建。
 *
 * 这一整块此前在 shell（`src/main/i18n/language-packs.ts` + `index.ts` +
 * `preference.ts`）。搬过来的理由和插件贡献点一样：**语言包是插件目录里的数据**，
 * 而读插件目录已经只有 host 一家；再让 shell 拿着同一份数据重建一次瀑布，就是第二
 * 份实现。现在 shell 只缓存 host 给出的 `I18nPayload`：
 *
 * - 窗口标题 / 原生菜单 / 对话框要 `t()`，而 `t()` 需要词条表 —— 那是同步调用，
 *   所以载荷必须留在 shell 内存里（见 `src/main/i18n`）；
 * - 语言包本身、逐 key 瀑布、missing / extra / conflicts 诊断全在这里。
 *
 * 语言偏好在 `<userData>/locale.json`（和插件偏好同一个目录、同一套「坏文件当没
 * 偏好」的策略）。系统语言只有 Electron 知道，所以启动时由 shell 把候选链传进来。
 */

/** 宿主的中文基础表 —— 兜底地板（语言包再怎么缺也不会裸露 key） */
const BASE_MESSAGES: MessageTable = zhCN

const BASE_KEYS = Object.keys(BASE_MESSAGES)

/**
 * 中文在语言选择列表里的名字。
 *
 * 刻意写成中文而不是查词条表 —— 语言的**自称**不参与翻译体系，否则就会出现
 * 「翻译『语言』这个词本身」的循环。英文包自称 "English"，同理。
 */
const DEFAULT_LOCALE_LABEL = '简体中文'

const PREFERENCE_FILE_NAME = 'locale.json'

/** 一个语言包读进来的完整内容 */
export interface LanguagePackEntry {
  locale: LocaleId
  label: string
  source: LocaleSourceTier
  pluginId: string
  dir: string
  messages: MessageTable
}

export interface ResolvedMessages {
  locale: LocaleId
  messages: MessageTable
  diagnostics: I18nPayload['diagnostics']
}

function refOf(entry: LanguagePackEntry): LocaleProviderRef {
  return { pluginId: entry.pluginId, source: entry.source, locale: entry.locale }
}

function warn(message: string, fields?: Record<string, unknown>): void {
  if (fields) console.warn(`[nide-host] ${message}`, fields)
  else console.warn(`[nide-host] ${message}`)
}

function info(message: string, fields?: Record<string, unknown>): void {
  if (fields) console.info(`[nide-host] ${message}`, fields)
  else console.info(`[nide-host] ${message}`)
}

/**
 * 语言包注册表。
 *
 * 只存「读进来的词条数据」，不碰文件系统 —— 读盘在 `plugin-contributions.ts`。
 * 这样它可以被直接单测，也不需要 mock fs。
 */
export class LanguagePackRegistry {
  private entries: LanguagePackEntry[] = []

  reset(): void {
    this.entries = []
  }

  register(entry: LanguagePackEntry): void {
    this.entries.push({ ...entry, locale: normalizeLocale(entry.locale) })
  }

  getAll(): LanguagePackEntry[] {
    return this.entries
  }

  /**
   * 按「从具体到宽泛」的候选链找第一个有包的 locale。
   *
   * "en-GB" 在只有 "en" 包时命中 "en"，作者不必为每个地区复制一份词条。
   * 返回 null 表示一个候选都没有。
   */
  matchLocale(requested: LocaleId): LocaleId | null {
    const installed = new Set(this.entries.map((entry) => entry.locale))
    for (const candidate of localeCandidates(requested)) {
      if (installed.has(candidate)) return candidate
    }
    return null
  }

  /**
   * 逐 key 瀑布要走的包链，从最优先到最靠后。
   *
   * 排序三层，从外到内（见 buildMessages 的说明）：tier -> locale 具体度 ->
   * pluginId 字典序。三层都是确定的，不依赖磁盘扫描顺序。
   */
  resolveChain(requested: LocaleId): LanguagePackEntry[] {
    const candidates = localeCandidates(requested)
    const specificity = new Map(candidates.map((tag, index) => [tag, index]))

    return this.entries
      .filter((entry) => specificity.has(entry.locale))
      .sort((a, b) => {
        // 1. 第三方优先：用户主动装的包必须盖得住宿主内置的那份
        const tier = TIER_PRIORITY[b.source] - TIER_PRIORITY[a.source]
        if (tier !== 0) return tier

        // 2. locale 由具体到宽泛：请求 en-GB 时 en-US 打头、en 兜后
        const exact =
          (specificity.get(a.locale) ?? Number.MAX_SAFE_INTEGER) -
          (specificity.get(b.locale) ?? Number.MAX_SAFE_INTEGER)
        if (exact !== 0) return exact

        // 3. pluginId 字典序：兜到最后一层也必须是确定的
        return a.pluginId.localeCompare(b.pluginId, 'en')
      })
  }

  hasLocale(locale: LocaleId): boolean {
    const target = normalizeLocale(locale)
    return this.entries.some((entry) => entry.locale === target)
  }

  /**
   * 可切换的语言列表。
   *
   * 同一个 locale 有多个包时，展示**链首那个包**的名字和来源 —— 用户会在菜单里看到
   * 两个 "English"，不标出哪个优先就不知道该信谁。
   */
  descriptors(): LocaleDescriptor[] {
    const byLocale = new Map<LocaleId, LanguagePackEntry>()

    for (const entry of this.entries) {
      const current = byLocale.get(entry.locale)
      if (!current || TIER_PRIORITY[entry.source] > TIER_PRIORITY[current.source]) {
        byLocale.set(entry.locale, entry)
      }
    }

    return Array.from(byLocale.values())
      .map((entry) => ({
        locale: entry.locale,
        label: entry.label,
        source: entry.source,
        pluginId: entry.pluginId,
        dir: entry.dir
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  }

  /**
   * 合并出某个 locale 的最终词条表。
   *
   * 逐 key 的瀑布，不是「整份包互相覆盖」：
   *
   *   第三方包 -> 内置包 -> 中文基础表
   *
   * 链上第一个提供某个 key 的包，这个 key 就归它；链上都没有才落到中文基础表。
   * 所以第三方包只翻了一半也没关系 —— 没翻的那几条会被内置包接住。
   */
  buildMessages(locale: LocaleId): ResolvedMessages {
    const target = normalizeLocale(locale)
    const chain = this.resolveChain(target)

    const messages: MessageTable = { ...BASE_MESSAGES }
    const provider = new Map<string, LocaleProviderRef>()
    const conflicts: LocaleConflict[] = []

    for (const pack of chain) {
      const ref = refOf(pack)

      for (const [key, value] of Object.entries(pack.messages)) {
        const previous = provider.get(key)

        if (previous) {
          // 只有「译文真的不一样」才算冲突：第三方包常常整份复制内置包再改几条
          if (previous.pluginId !== ref.pluginId && messages[key] !== value) {
            conflicts.push({ locale: target, key, winner: previous, loser: ref })
          }
          continue
        }

        provider.set(key, ref)
        messages[key] = value
      }
    }

    const missing = target === DEFAULT_LOCALE ? [] : BASE_KEYS.filter((key) => !provider.has(key))
    const extra = Array.from(provider.keys()).filter((key) => !(key in BASE_MESSAGES))

    return {
      locale: target,
      messages,
      diagnostics: {
        locale: target,
        missing,
        extra,
        conflicts,
        providers: Object.fromEntries(provider)
      }
    }
  }
}

/** 日志里怎么称呼一个包：带 locale，因为瀑布会跨 locale 取词 */
function describeRef(ref: LocaleProviderRef): string {
  return `${ref.pluginId}[${ref.locale}/${ref.source}]`
}

/**
 * 漏翻体检的出口。
 *
 * 语言包是运行时从磁盘读的，TypeScript 管不到它的 key —— 唯一能发现「翻漏了」的
 * 办法就是启动时比对 key 集合，并大声说出来。静默回落成中文是这个方案最大的隐患。
 */
function reportDiagnostics(payload: I18nPayload): void {
  const { locale, diagnostics } = payload

  if (payload.fallbackFrom) {
    warn('Language pack not found, falling back', {
      requested: payload.fallbackFrom,
      fallback: locale
    })
  }

  if (diagnostics.missing.length > 0) {
    warn('Missing messages', { locale, count: diagnostics.missing.length })
  }

  if (diagnostics.extra.length > 0) {
    warn('Extra messages not present in the host table', {
      locale,
      count: diagnostics.extra.length
    })
  }

  if (diagnostics.conflicts.length > 0) {
    warn('Message conflicts', { locale, count: diagnostics.conflicts.length })
    for (const conflict of diagnostics.conflicts) {
      console.debug('[nide-host] Message conflict', {
        key: conflict.key,
        winner: describeRef(conflict.winner),
        loser: describeRef(conflict.loser)
      })
    }
  }

  // 一个 locale 由多个包共同供给是常态，按包汇总的那一行是 info
  const served = Object.entries(diagnostics.providers)
  if (served.length > 0) {
    const byPlugin = new Map<string, number>()
    for (const [, ref] of served) {
      const label = describeRef(ref)
      byPlugin.set(label, (byPlugin.get(label) ?? 0) + 1)
    }

    info('Message providers', { locale, total: served.length, packs: Object.fromEntries(byPlugin) })
  }
}

/**
 * 把 manifest 里的 `%key%` 按给定语言解析成文案。
 *
 * 解析链：精确 locale -> 放宽的 locale（en-US 命中 en）-> 插件默认表 -> 原样返回。
 * 最后一档刻意保留原样的 `%key%`：漏翻会显眼地出现在界面上，而不是静默变空。
 *
 * 纯函数，独立导出是为了单测（`HostI18n` 只是把「当前语言」补上）。
 */
export function resolvePluginTitle(
  tables: PluginManifestNls | undefined,
  spec: string,
  locale: LocaleId
): string {
  const key = parsePlaceholder(spec)
  // 不是占位符就是普通字符串，原样用（老插件不用改 manifest 也能正常工作）
  if (key === null) return spec
  if (!tables) return spec

  for (const candidate of localeCandidates(locale)) {
    const value = tables.byLocale[candidate]?.[key]
    if (value !== undefined) return value
  }

  return tables.defaultTable?.[key] ?? spec
}

export interface HostI18nOptions {
  /** Electron 的 userData 目录（`locale.json` 落在这里） */
  userDataDir: string
}

/**
 * 本地化的宿主服务：语言包集合 + 当前语言 + 偏好文件。
 *
 * 语言包集合由调用方在每次使用前灌入（`setPacks(plugins.contributions().locales)`）——
 * 插件安装 / 卸载 / 重扫之后语言包可能变了，缓存一份就要处理失效，而这是内存里的
 * 一次遍历，直接重灌最简单。
 */
export class HostI18n {
  private readonly registry = new LanguagePackRegistry()
  private readonly userDataDir: string

  private currentLocale: LocaleId = DEFAULT_LOCALE
  private currentPayload: I18nPayload = {
    locale: DEFAULT_LOCALE,
    messages: BASE_MESSAGES,
    available: [],
    diagnostics: { locale: DEFAULT_LOCALE, missing: [], extra: [], conflicts: [], providers: {} }
  }

  constructor(options: HostI18nOptions) {
    this.userDataDir = options.userDataDir
  }

  /** 用插件贡献的语言包整体替换当前集合 */
  setPacks(packs: readonly PluginLocalePack[]): void {
    this.registry.reset()
    for (const pack of packs) {
      this.registry.register({
        locale: pack.locale,
        label: pack.label,
        source: pack.source,
        pluginId: pack.pluginId,
        dir: pack.dir,
        messages: pack.messages
      })
    }
  }

  payload(): I18nPayload {
    return this.currentPayload
  }

  locale(): LocaleId {
    return this.currentLocale
  }

  /**
   * 启动时定语言：偏好优先，其次系统语言候选链；都接不住就回落中文。
   *
   * 系统语言只有 Electron 知道（`app.getPreferredSystemLanguages`），所以候选链由
   * shell 传进来，host 只负责挑一个**确实装了语言包**的。
   */
  init(system: readonly LocaleId[]): I18nPayload {
    const preferred = this.readPreference()
    const candidates = preferred ? [preferred, ...system] : [...system]

    const { locale, fallbackFrom } = this.resolveLocale(candidates)
    this.currentLocale = locale
    this.currentPayload = this.buildPayload(locale, fallbackFrom)

    reportDiagnostics(this.currentPayload)
    info('Locale resolved', {
      locale,
      available: this.currentPayload.available.map((descriptor) => descriptor.locale)
    })

    return this.currentPayload
  }

  /**
   * 切换语言：落盘 + 重建载荷。返回 null 表示这个 locale 没有语言包，什么都没改。
   *
   * **不重建窗口** —— 那是 shell 的事（窗口标题、启动参数都是建窗时固定的）。
   */
  setLocale(requested: LocaleId): I18nPayload | null {
    const normalized = normalizeLocale(requested)

    if (normalized !== DEFAULT_LOCALE && !this.registry.matchLocale(normalized)) {
      warn('Refusing to switch to a locale with no language pack', { locale: normalized })
      return null
    }

    this.writePreference(normalized)
    this.currentLocale = normalized
    this.currentPayload = this.buildPayload(normalized)

    reportDiagnostics(this.currentPayload)
    info('Locale switched', { locale: normalized })
    return this.currentPayload
  }

  /** 按**当前语言**解析插件的 `%key%` 标题 */
  resolveTitle(tables: PluginManifestNls | undefined, spec: string): string {
    return resolvePluginTitle(tables, spec, this.currentLocale)
  }

  /**
   * 宿主**自己的**词条（`host.*`）。
   *
   * 和 `resolveTitle` 是两条路：那个解析插件 manifest 的 `%key%` 占位符（没有 `%`
   * 就原样返回）。内建视图 / 菜单 / 对话框的标题直接就是宿主词条表的 key，走错那条
   * 会把 `host.git.title` 当普通字符串显示在界面上（迁移到 host 后就这么错过一次）。
   *
   * 缺 key 时返回 key 本身（和渲染进程的回落一致），并留一条 warn 便于发现漏词条。
   */
  message(key: string): string {
    const value = this.currentPayload.messages[key] ?? BASE_MESSAGES[key]
    if (value === undefined) {
      warn('Missing host message key', { key, locale: this.currentLocale })
      return key
    }
    return value
  }

  private preferencePath(): string {
    return path.join(this.userDataDir, PREFERENCE_FILE_NAME)
  }

  private readPreference(): LocaleId | null {
    try {
      const raw = fs.readFileSync(this.preferencePath(), 'utf-8')
      const parsed = JSON.parse(raw) as { locale?: unknown }
      if (typeof parsed.locale !== 'string' || parsed.locale.length === 0) return null
      return normalizeLocale(parsed.locale)
    } catch {
      // 文件不存在 / 内容坏了都走这条：没偏好不是错误，回落到系统语言即可
      return null
    }
  }

  private writePreference(locale: LocaleId): void {
    const target = this.preferencePath()
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, `${JSON.stringify({ locale }, null, 2)}\n`, 'utf-8')
    } catch (error) {
      // 写不进去只影响「下次启动还记得」，不该让切语言整体失败
      warn('Failed to write the language preference', { error })
    }
  }

  /**
   * 从候选链里挑一个**确实装了语言包**的 locale。
   *
   * 三个刻意的选择（与搬迁前一致）：
   * - 中文直接接受，不需要语言包（它是内建的地板）。
   * - 命中的是「实际生效的 locale」，可能比请求的更宽泛（请求 en-GB、装了 en 包
   *   就返回 en）。界面按这个值勾选，用户看到的就是真正在用的那份。
   * - 一个候选都没命中时，把「本来想要但没包」的那个报成 fallbackFrom。
   */
  private resolveLocale(candidates: readonly LocaleId[]): {
    locale: LocaleId
    fallbackFrom?: LocaleId
  } {
    for (const tag of candidates) {
      const normalized = normalizeLocale(tag)
      if (normalized === DEFAULT_LOCALE) return { locale: DEFAULT_LOCALE }

      const matched = this.registry.matchLocale(normalized)
      if (matched) return { locale: matched }
    }

    const wanted = candidates.map(normalizeLocale).find((tag) => tag !== DEFAULT_LOCALE)
    return wanted ? { locale: DEFAULT_LOCALE, fallbackFrom: wanted } : { locale: DEFAULT_LOCALE }
  }

  /** 中文永远可选：它是内建的，不依赖任何语言包存在 */
  private availableLocales(): LocaleDescriptor[] {
    const fromPacks = this.registry.descriptors()
    const list = fromPacks.some((descriptor) => descriptor.locale === DEFAULT_LOCALE)
      ? fromPacks
      : [
          {
            locale: DEFAULT_LOCALE,
            label: DEFAULT_LOCALE_LABEL,
            source: 'builtin' as const,
            pluginId: '<host>',
            dir: ''
          },
          ...fromPacks
        ]

    return list.sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'))
  }

  private buildPayload(locale: LocaleId, fallbackFrom?: LocaleId): I18nPayload {
    const resolved = this.registry.buildMessages(locale)
    return {
      locale: resolved.locale,
      messages: resolved.messages,
      available: this.availableLocales(),
      ...(fallbackFrom ? { fallbackFrom } : {}),
      diagnostics: resolved.diagnostics
    }
  }
}
