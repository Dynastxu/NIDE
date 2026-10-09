import {
  BASE_MESSAGES,
  DEFAULT_LOCALE,
  TIER_PRIORITY,
  localeCandidates,
  normalizeLocale
} from '@shared/i18n'
import type {
  LocaleConflict,
  LocaleDescriptor,
  LocaleDiagnostics,
  LocaleId,
  LocaleProviderRef,
  LocaleSourceTier,
  MessageTable
} from '@shared/i18n'

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
  diagnostics: LocaleDiagnostics
}

const BASE_KEYS = Object.keys(BASE_MESSAGES)

function refOf(entry: LanguagePackEntry): LocaleProviderRef {
  return { pluginId: entry.pluginId, source: entry.source, locale: entry.locale }
}

/**
 * 语言包注册表。
 *
 * 只存「读进来的词条数据」，不碰文件系统 —— 读盘和路径校验归 loader。
 * 这样注册表可以被直接单测，也不需要 mock fs。
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

  /** 卸载插件时把它贡献的语言包一起摘掉 */
  unregisterByPlugin(pluginId: string): void {
    this.entries = this.entries.filter((entry) => entry.pluginId !== pluginId)
  }

  /**
   * 按「从具体到宽泛」的候选链找第一个有包的 locale。
   *
   * "en-GB" 在只有 "en" 包时命中 "en"，作者不必为每个地区复制一份词条。
   * 返回 null 表示一个候选都没有。
   */
  matchLocale(requested: LocaleId): LocaleId | null {
    const installed = new Set(this.entries.map((e) => e.locale))
    for (const candidate of localeCandidates(requested)) {
      if (installed.has(candidate)) return candidate
    }
    return null
  }

  /**
   * 逐 key 瀑布要走的包链，从最优先到最靠后。
   *
   * 只要有包能接住请求的 locale（精确或放宽），这条链就一定非空 ——
   * 空链意味着「这个 locale 一个包都没有」，那时整张表都是中文基础表。
   *
   * 排序三层，从外到内，见 buildMessages 的说明。locale 具体度用的是候选链下标，
   * 所以 "en-US" 请求下 en-US 包排在 en 包前面。
   */
  resolveChain(requested: LocaleId): LanguagePackEntry[] {
    const candidates = localeCandidates(requested)
    const specificity = new Map(candidates.map((tag, index) => [tag, index]))

    return this.entries
      .filter((entry) => specificity.has(entry.locale))
      .sort((a, b) => {
        // 1. 第三方优先：用户主动装的包必须盖得住宿主内置的那份，否则装了不生效
        const tier = TIER_PRIORITY[b.source] - TIER_PRIORITY[a.source]
        if (tier !== 0) return tier

        // 2. locale 由具体到宽泛：请求 en-GB 时 en-US 打头、en 兜后
        const exact =
          (specificity.get(a.locale) ?? Number.MAX_SAFE_INTEGER) -
          (specificity.get(b.locale) ?? Number.MAX_SAFE_INTEGER)
        if (exact !== 0) return exact

        // 3. pluginId 字典序：兜到最后一层也必须是确定的，不能看磁盘扫描顺序
        return a.pluginId.localeCompare(b.pluginId, 'en')
      })
  }

  hasLocale(locale: LocaleId): boolean {
    const target = normalizeLocale(locale)
    return this.entries.some((e) => e.locale === target)
  }

  /**
   * 可切换的语言列表。
   *
   * 同一个 locale 有多个包时，展示**链首那个包**的名字和来源 ——
   * 用户会在菜单里看到两个 "English"，不标出哪个优先就不知道该信谁。
   *
   * 列表本身是「一门语言一条」：取词是逐 key 瀑布、可以多个包共同供给，
   * 但选语言这个动作的粒度是语言，不是包。
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
   * 这是一条**逐 key 的瀑布**，不是「整份包互相覆盖」：
   *
   *   第三方包 -> 内置包 -> 中文基础表
   *
   * 链上第一个提供某个 key 的包，这个 key 就归它；链上都没有，才落到中文基础表。
   * 所以第三方包只翻了一半也没关系 —— 没翻的那几条会被内置包接住，而不是
   * 让内置包整体失效。反过来，第三方包不会因为漏翻而丢掉自己翻过的那部分。
   *
   * 链的排序（见 resolveChain）三层，从外到内：
   *   1. tier：第三方 -> 内置。
   *   2. locale 具体度：请求 en-GB 时，en-US 包先于 en 包、更先于 zh-CN 兜底。
   *   3. pluginId 字典序。
   * 三层都是**确定**的，不依赖磁盘扫描顺序 —— 同一个环境下结果永远一样。
   */
  buildMessages(locale: LocaleId): ResolvedMessages {
    const target = normalizeLocale(locale)
    const chain = this.resolveChain(target)

    // 中文基础表是地板：链上一个包都没有的 key 用它
    const messages: MessageTable = { ...BASE_MESSAGES }
    const provider = new Map<string, LocaleProviderRef>()
    const conflicts: LocaleConflict[] = []

    for (const pack of chain) {
      const ref = refOf(pack)

      for (const [key, value] of Object.entries(pack.messages)) {
        const previous = provider.get(key)

        if (previous) {
          /**
           * 同一个 key 被链上靠后的包重复提供：靠前的那个才是最终译文。
           *
           * 只有「译文真的不一样」才算冲突 —— 第三方包常常整份复制内置包再改几条，
           * 逐条报「重复」只会淹没真正的问题。
           */
          if (previous.pluginId !== ref.pluginId && messages[key] !== value) {
            conflicts.push({ locale: target, key, winner: previous, loser: ref })
          }
          continue
        }

        provider.set(key, ref)
        messages[key] = value
      }
    }

    // 基础表就是中文，所以「中文缺翻译」这个说法本身不成立。
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

export const languagePackRegistry = new LanguagePackRegistry()
