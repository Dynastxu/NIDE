import { app } from 'electron'
import { BASE_MESSAGES, DEFAULT_LOCALE, createTranslator, normalizeLocale } from '@shared/i18n'
import type {
  I18nPayload,
  LocaleDescriptor,
  LocaleId,
  LocaleProviderRef,
  Translator
} from '@shared/i18n'
import { languagePackRegistry } from './language-packs'
import { readPreferredLocale, writePreferredLocale } from './preference'

export { languagePackRegistry } from './language-packs'
export type { LanguagePackEntry } from './language-packs'

/**
 * 中文在语言选择列表里的名字。
 *
 * 刻意写成中文而不是查词条表 —— 语言的**自称**不参与翻译体系，
 * 否则就会出现「翻译『语言』这个词本身」的循环。同理，英文包自称 "English"。
 */
const DEFAULT_LOCALE_LABEL = '简体中文'

let currentLocale: LocaleId = DEFAULT_LOCALE

let currentPayload: I18nPayload = {
  locale: DEFAULT_LOCALE,
  messages: BASE_MESSAGES,
  available: [],
  diagnostics: { locale: DEFAULT_LOCALE, missing: [], extra: [], conflicts: [], providers: {} }
}

/** 系统可能给出多个候选（['zh-Hans-CN', 'zh', 'en-US']），按顺序试 */
function systemLanguageCandidates(): LocaleId[] {
  const raw: string[] = []
  try {
    if (typeof app.getPreferredSystemLanguages === 'function') {
      raw.push(...app.getPreferredSystemLanguages())
    }
  } catch {
    // 老版本 Electron 没有这个 API，下面的 app.getLocale() 兜住
  }
  const single = app.getLocale()
  if (single) raw.push(single)
  return raw.map(normalizeLocale)
}

/**
 * 从候选链里挑一个**确实装了语言包**的 locale。
 *
 * 三个刻意的选择：
 * - 中文直接接受，不需要语言包（它是宿主内建的兜底地板）。
 * - 命中的是「实际生效的 locale」，可能比请求的更宽泛（请求 en-GB、装了 en 包
 *   就返回 en）。界面按这个值勾选，用户看到的就是真正在用的那份。
 * - 一个候选都没命中时，把「本来想要但没包」的那个 locale 报成 fallbackFrom，
 *   让界面能给出可见提示，而不是静默变回中文。
 */
function resolveLocale(candidates: LocaleId[]): { locale: LocaleId; fallbackFrom?: LocaleId } {
  for (const tag of candidates) {
    const normalized = normalizeLocale(tag)
    if (normalized === DEFAULT_LOCALE) return { locale: DEFAULT_LOCALE }

    const matched = languagePackRegistry.matchLocale(normalized)
    if (matched) return { locale: matched }
  }

  const wanted = candidates.map(normalizeLocale).find((tag) => tag !== DEFAULT_LOCALE)
  return wanted ? { locale: DEFAULT_LOCALE, fallbackFrom: wanted } : { locale: DEFAULT_LOCALE }
}

/** 中文永远可选：它是内建的，不依赖任何语言包存在 */
function availableLocales(): LocaleDescriptor[] {
  const fromPacks = languagePackRegistry.descriptors()
  const list = fromPacks.some((d) => d.locale === DEFAULT_LOCALE)
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

function buildPayload(locale: LocaleId, fallbackFrom?: LocaleId): I18nPayload {
  const resolved = languagePackRegistry.buildMessages(locale)
  return {
    locale: resolved.locale,
    messages: resolved.messages,
    available: availableLocales(),
    ...(fallbackFrom ? { fallbackFrom } : {}),
    diagnostics: resolved.diagnostics
  }
}

/** 日志里怎么称呼一个包：带 locale，因为瀑布会跨 locale 取词 */
function describeRef(ref: LocaleProviderRef): string {
  return `${ref.pluginId}[${ref.locale}/${ref.source}]`
}

/**
 * 漏翻体检的出口。
 *
 * 语言包是运行时从磁盘读的，TypeScript 管不到它的 key —— 所以唯一能发现
 * 「翻漏了」的办法就是启动时比对 key 集合，并大声说出来。静默回落成中文
 * 是这个方案最大的隐患，这里就是它的对策。
 */
function reportDiagnostics(payload: I18nPayload): void {
  const { locale, diagnostics } = payload

  if (payload.fallbackFrom) {
    console.warn(
      `[i18n] Language pack for "${payload.fallbackFrom}" not found, fallback to "${locale}"`
    )
  }

  // 逐 key 瀑布下这个数字的含义要说清：链上所有语言包都没翻的 key，
  // 不是「某一个包漏翻的 key」—— 漏翻的包会被后面的包接住，不报在这里。
  if (diagnostics.missing.length > 0) {
    console.warn(
      `[i18n] "${locale}" has ${diagnostics.missing.length} missing messages: \n` +
        diagnostics.missing.map((key) => `  - ${key}`).join('\n')
    )
  }

  if (diagnostics.extra.length > 0) {
    console.warn(
      `[i18n] "${locale}" has ${diagnostics.extra.length} extra messages: \n` +
        diagnostics.extra.map((key) => `  - ${key}`).join('\n')
    )
  }

  if (diagnostics.conflicts.length > 0) {
    console.warn(
      `[i18n] "${locale}" has ${diagnostics.conflicts.length} conflicts: \n` +
        diagnostics.conflicts
          .map(
            (c) =>
              `  - ${c.key}: winner is ${describeRef(c.winner)} loser is ${describeRef(c.loser)}`
          )
          .join('\n')
    )
  }

  // 一个 locale 由多个包共同供给是常态（第三方翻一半、内置补另一半），
  // 所以把「每个 key 实际是谁给的」也打出来 —— 漏翻排查全靠它。
  const served = Object.entries(diagnostics.providers)
  if (served.length > 0) {
    const byPlugin = new Map<string, string[]>()
    for (const [key, ref] of served) {
      const bucket = byPlugin.get(describeRef(ref)) ?? []
      bucket.push(key)
      byPlugin.set(describeRef(ref), bucket)
    }

    console.log(
      `[i18n] ${served.length} pieces of copy for "${locale}" are provided by ${byPlugin.size} packages: \n` +
        Array.from(byPlugin.entries())
          .map(([plugin, keys]) => `  - ${plugin}: ${keys.length} pieces`)
          .join('\n')
    )
  }
}

/**
 * 初始化本地化。
 *
 * **必须在 initPluginHost() 之后调用** —— 语言包是随插件 manifest 一起注册的，
 * 注册表空着的话所有 locale 都会回落成中文。
 */
export function initI18n(): void {
  const preferred = readPreferredLocale()
  const candidates = preferred
    ? [preferred, ...systemLanguageCandidates()]
    : systemLanguageCandidates()

  const { locale, fallbackFrom } = resolveLocale(candidates)
  currentLocale = locale
  currentPayload = buildPayload(locale, fallbackFrom)

  reportDiagnostics(currentPayload)
  console.log(
    `[i18n] locale=${currentLocale}, available languages ${currentPayload.available
      .map((d) => d.locale)
      .join(', ')}`
  )
}

export function getCurrentLocale(): LocaleId {
  return currentLocale
}

export function getI18nPayload(): I18nPayload {
  return currentPayload
}

/** 主进程侧的 t()：原生菜单、对话框、窗口标题用它 */
export function createMainTranslator(): Translator {
  return createTranslator(currentPayload.messages)
}

/**
 * 切换语言：落盘 + 重建载荷。
 *
 * **刻意不在这里重建窗口** —— 那样 i18n 就得反向依赖窗口模块，形成循环。
 * 调用方（IPC / 菜单）负责在自己合适的时机调 recreateMainWindow()。
 *
 * 返回 false 表示这个 locale 没有语言包，什么都没改。
 */
export function switchLocale(locale: LocaleId): boolean {
  const normalized = normalizeLocale(locale)

  if (normalized !== DEFAULT_LOCALE && !languagePackRegistry.matchLocale(normalized)) {
    console.error(`[i18n] Refusing to switch to locale with no language pack: "${normalized}"`)
    return false
  }

  writePreferredLocale(normalized)
  currentLocale = normalized
  currentPayload = buildPayload(normalized)
  reportDiagnostics(currentPayload)
  return true
}
