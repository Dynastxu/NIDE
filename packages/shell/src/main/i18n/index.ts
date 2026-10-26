import { app } from 'electron'
import {
  BASE_MESSAGES,
  DEFAULT_LOCALE,
  createTranslator,
  normalizeLocale
} from '@nide/contracts/i18n'
import type { I18nPayload, LocaleId, Translator } from '@nide/contracts/i18n'
import { invokeHost } from '../host/process'
import { loggerFor } from '../logger'

/**
 * shell 侧的本地化缓存。
 *
 * 语言包、逐 key 瀑布、语言偏好、manifest 词条解析**全都在 host**
 * （[i18n.ts](../../packages/host/src/services/i18n.ts)）：语言包是插件目录里的数据，
 * 而读插件目录只有 host 一家。
 *
 * 这里保留一份 `I18nPayload` 是因为它必须能**同步**取到：窗口标题、原生菜单、
 * 对话框、`--nide-locale=` 启动参数都在建窗那一刻要文案，而那一步跑不了 IPC。
 * 所以启动时拉一次，切语言时再拉一次 —— 别的地方不要自己存词条。
 */

const logger = loggerFor('i18n')

/** 中文兜底：host 还没回话（或起不来）时至少不裸露 key */
let currentLocale: LocaleId = DEFAULT_LOCALE

let currentPayload: I18nPayload = {
  locale: DEFAULT_LOCALE,
  messages: BASE_MESSAGES,
  available: [],
  diagnostics: { locale: DEFAULT_LOCALE, missing: [], extra: [], conflicts: [], providers: {} }
}

/**
 * 系统可能给出多个候选（['zh-Hans-CN', 'zh', 'en-US']），按顺序试。
 *
 * 这一份**只能在 shell 拿**：`app.getPreferredSystemLanguages()` / `app.getLocale()`
 * 是 Electron 的 API。所以启动时把候选链交给 host，由它挑一个装了语言包的。
 */
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
 * 初始化本地化：问 host 要一份载荷并缓存。
 *
 * **必须在开窗之前完成**（窗口标题与启动参数都要它）。host 不可达时保持中文兜底
 * 并记日志 —— 界面会是中文，但不会出现裸 key。
 */
export async function initI18n(): Promise<void> {
  try {
    const payload = await invokeHost<I18nPayload>('i18n', 'init', [
      { system: systemLanguageCandidates() }
    ])
    currentLocale = payload.locale
    currentPayload = payload
  } catch (error) {
    logger.error('Failed to resolve the locale through host; keeping Chinese', { error })
    return
  }

  logger.info('Locale resolved', {
    locale: currentLocale,
    available: currentPayload.available.map((descriptor) => descriptor.locale)
  })
}

export function getCurrentLocale(): LocaleId {
  return currentLocale
}

export function getI18nPayload(): I18nPayload {
  return currentPayload
}

/** shell 侧的 t()：原生菜单、对话框、窗口标题用它 */
export function createMainTranslator(): Translator {
  return createTranslator(currentPayload.messages)
}

/**
 * 切换语言：落盘与重建载荷在 host，这里只刷新缓存。
 *
 * **刻意不重建窗口** —— 那样 i18n 就要反向依赖窗口模块，形成循环。调用方
 * （IPC / 菜单）负责在自己合适的时机调 `recreateRootWindow()`。
 *
 * 返回 false 表示这个 locale 没有语言包（host 那边什么都没改）。
 */
export async function switchLocale(locale: LocaleId): Promise<boolean> {
  try {
    const payload = await invokeHost<I18nPayload | null>('i18n', 'setLocale', [locale])
    if (!payload) return false

    currentLocale = payload.locale
    currentPayload = payload
    logger.info('Locale switched', { locale: currentLocale })
    return true
  } catch (error) {
    logger.error('Failed to switch the locale through host', { error })
    return false
  }
}
