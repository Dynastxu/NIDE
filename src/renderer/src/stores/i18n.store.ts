import { create } from 'zustand'
import { BASE_MESSAGES, DEFAULT_LOCALE, createTranslator } from '@shared/i18n'
import type {
  I18nPayload,
  LocaleDescriptor,
  LocaleDiagnostics,
  LocaleId,
  MessageTable,
  Translator
} from '@shared/i18n'

interface I18nState {
  /** 词条表是否已就位。为 false 时 t() 只会给出中文基础表 */
  ready: boolean
  locale: LocaleId
  messages: MessageTable
  available: LocaleDescriptor[]
  /** 有值表示「想要的语言没装包、被迫回落」，界面应该提示 */
  fallbackFrom?: LocaleId
  diagnostics: LocaleDiagnostics
  /**
   * 翻译函数**存在 store 里**，而不是每次渲染现造一个。
   *
   * 这样组件 `useI18nStore((s) => s.t)` 只订阅一个引用，语言变化时引用换新、
   * 自动重渲染；没变时引用稳定，不会白白重渲染。
   */
  t: Translator

  load: () => Promise<void>
  requestLocale: (locale: LocaleId) => Promise<void>
}

/** 空体检报告。providers 是新加的字段，这里给一个和主进程一致的空形状 */
function emptyDiagnostics(): LocaleDiagnostics {
  return { locale: DEFAULT_LOCALE, missing: [], extra: [], conflicts: [], providers: {} }
}

/** 模块级 in-flight promise：多个组件同时触发加载时只打一次 IPC */
let inflight: Promise<void> | null = null

function hydrate(payload: I18nPayload): Partial<I18nState> {
  const state: Partial<I18nState> = {
    ready: true,
    locale: payload.locale,
    messages: payload.messages,
    available: payload.available,
    diagnostics: payload.diagnostics,
    t: createTranslator(payload.messages)
  }

  if (payload.fallbackFrom) {
    state.fallbackFrom = payload.fallbackFrom
    console.warn(
      `[i18n] 没有找到 "${payload.fallbackFrom}" 的语言包，界面已回落成 "${payload.locale}"`
    )
  }

  if (payload.diagnostics.missing.length > 0) {
    console.warn(
      `[i18n] "${payload.locale}" 有 ${payload.diagnostics.missing.length} 条文案未翻译，` +
        `这些位置会显示中文`
    )
  }

  return state
}

export const useI18nStore = create<I18nState>((set) => ({
  ready: false,
  locale: DEFAULT_LOCALE,
  messages: BASE_MESSAGES,
  available: [],
  diagnostics: emptyDiagnostics(),
  t: createTranslator(BASE_MESSAGES),

  load: async () => {
    if (inflight) return inflight

    inflight = window.hostAPI
      .getI18n()
      .then((payload) => set(hydrate(payload)))
      .catch((err: unknown) => {
        // 拿不到词条表不该白屏：中文基础表已经在 store 里了，界面照常可用
        console.error('[i18n] 加载词条表失败，已回落成中文基础表', err)
      })
      .finally(() => {
        inflight = null
      })

    return inflight
  },

  requestLocale: async (locale) => {
    // 主进程会先弹确认框（重建窗口会丢掉未保存内容），确认后才真正切换并重建
    await window.hostAPI.setLocale(locale)
  }
}))

/**
 * 组件里取 t()。
 *
 * 订阅的是 `t` 这个引用本身，语言一变引用就换，组件自然重渲染。
 */
export function useT(): Translator {
  return useI18nStore((s) => s.t)
}

/** 非组件代码（插件加载器、事件回调）里取 t() —— 注意这条路**不会**触发重渲染 */
export function getT(): Translator {
  return useI18nStore.getState().t
}
