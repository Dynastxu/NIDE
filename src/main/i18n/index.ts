import { app } from 'electron'
import { BASE_MESSAGES, DEFAULT_LOCALE, createTranslator, normalizeLocale } from '@shared/i18n'
import type { I18nPayload, LocaleDescriptor, LocaleId, Translator } from '@shared/i18n'
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
  diagnostics: { locale: DEFAULT_LOCALE, missing: [], extra: [], conflicts: [] }
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
    console.warn(`[i18n] 没有找到 "${payload.fallbackFrom}" 的语言包，已回落到 "${locale}"`)
  }

  if (diagnostics.missing.length > 0) {
    console.warn(
      `[i18n] "${locale}" 有 ${diagnostics.missing.length} 条文案未翻译，将显示中文：\n` +
        diagnostics.missing.map((key) => `  - ${key}`).join('\n')
    )
  }

  if (diagnostics.extra.length > 0) {
    console.warn(
      `[i18n] "${locale}" 的语言包里有 ${diagnostics.extra.length} 条宿主不认识的 key` +
        `（拼错或宿主已删除）：\n` +
        diagnostics.extra.map((key) => `  - ${key}`).join('\n')
    )
  }

  if (diagnostics.conflicts.length > 0) {
    console.warn(
      `[i18n] "${locale}" 有 ${diagnostics.conflicts.length} 条文案被多个语言包同时提供，` +
        `已按「第三方优先」取用：\n` +
        diagnostics.conflicts
          .map(
            (c) =>
              `  - ${c.key}: 采用 ${c.winner.pluginId}(${c.winner.source})，` +
              `覆盖 ${c.loser.pluginId}(${c.loser.source})`
          )
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
    `[i18n] locale=${currentLocale}, 可用语言 ${currentPayload.available
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
    console.error(`[i18n] 拒绝切换到 "${normalized}"：没有对应的语言包`)
    return false
  }

  writePreferredLocale(normalized)
  currentLocale = normalized
  currentPayload = buildPayload(normalized)
  reportDiagnostics(currentPayload)
  return true
}
