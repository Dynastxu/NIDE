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
  return { pluginId: entry.pluginId, source: entry.source }
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

  hasLocale(locale: LocaleId): boolean {
    const target = normalizeLocale(locale)
    return this.entries.some((e) => e.locale === target)
  }

  /**
   * 可切换的语言列表。
   *
   * 同一个 locale 有多个包时，展示**实际生效的那个包**的名字和来源，
   * 否则用户会在菜单里看到两个 "English" 却不知道点哪个生效。
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
   * 合并顺序就是优先级：中文基础表 -> 内置语言包 -> 第三方语言包。
   * **第三方最后合并，所以冲突时第三方胜出** —— 这是刻意的产品决策：
   * 用户主动装的语言包一定要盖得住宿主内置的那份，否则装了不生效。
   *
   * 顺序用稳定排序（ES2019+ 保证），所以同一层级内保持注册顺序（＝扫描顺序）。
   */
  buildMessages(locale: LocaleId): ResolvedMessages {
    const target = normalizeLocale(locale)
    const packs = this.entries
      .filter((e) => e.locale === target)
      .sort((a, b) => TIER_PRIORITY[a.source] - TIER_PRIORITY[b.source])

    const messages: MessageTable = { ...BASE_MESSAGES }
    const provider = new Map<string, LocaleProviderRef>()
    const conflicts: LocaleConflict[] = []

    for (const pack of packs) {
      for (const [key, value] of Object.entries(pack.messages)) {
        const previous = provider.get(key)

        // 只有「译文真的不一样」才算冲突。完全相同的重复提供是无害的
        // （第三方包常常整份复制内置包再改几条），报出来只会淹没真正的问题。
        if (previous && previous.pluginId !== pack.pluginId && messages[key] !== value) {
          conflicts.push({
            locale: target,
            key,
            winner: refOf(pack),
            loser: previous
          })
        }

        messages[key] = value
        provider.set(key, refOf(pack))
      }
    }

    // 基础表就是中文，所以「中文缺翻译」这个说法本身不成立。
    const missing = target === DEFAULT_LOCALE ? [] : BASE_KEYS.filter((key) => !provider.has(key))

    const extra = Array.from(provider.keys()).filter((key) => !(key in BASE_MESSAGES))

    return {
      locale: target,
      messages,
      diagnostics: { locale: target, missing, extra, conflicts }
    }
  }
}

export const languagePackRegistry = new LanguagePackRegistry()
