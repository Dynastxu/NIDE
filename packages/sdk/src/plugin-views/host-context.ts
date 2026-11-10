import { createContext, useContext, useMemo } from 'react'
import {
  BASE_MESSAGES,
  DEFAULT_LOCALE,
  createLooseTranslator,
  createTranslator
} from '@nide/contracts/i18n'
import type { LocaleId, LooseTranslator, MessageTable, Translator } from '@nide/contracts/i18n'
import { createPluginHostApi, type PluginHostApi } from './plugin-api'

/**
 * 宿主注入给**插件 UI** 的上下文。
 *
 * 职责划分是刻意的：
 * - 宿主只提供「现在是什么语言」「插值怎么做」「你是谁、能调什么」这几样**机制**。
 * - 词条**数据**归插件自己 —— 宿主不维护别家插件的文案，也维护不了。
 *
 * 注意 `t` 只认宿主自己的 key（类型是 `keyof typeof zhCN`，全是 `host.` 开头）。
 * 插件拿不到往宿主命名空间里写的能力，也就不会出现「插件把宿主界面文案改掉」。
 */
export interface PluginHostContextValue {
  /** 当前界面语言（BCP-47），插件据此挑自己的词条表 */
  locale: LocaleId
  /** 宿主词条表，只读。给插件读宿主已有的文案用 */
  t: Translator
  /** 用插件自己的词条表造一个 t()，插值规则与宿主一致 */
  createTranslator: (messages: MessageTable) => LooseTranslator
  /** 当前插件 id（清单里的 id，不是目录名） */
  pluginId: string
  /**
   * 受限的宿主 API：调用会带上本插件身份，宿主按 manifest 的 `permissions`
   * 拦截。插件里**不要**直接用 `window.hostAPI` —— 那等于绕过权限声明。
   */
  api: PluginHostApi
}

/** 没有 Provider 时的兜底：让插件在测试或独立渲染时也不至于炸 */
const FALLBACK: PluginHostContextValue = {
  locale: DEFAULT_LOCALE,
  t: createTranslator(BASE_MESSAGES),
  createTranslator: createLooseTranslator,
  pluginId: '',
  api: createPluginHostApi('')
}

export const PluginHostContext = createContext<PluginHostContextValue>(FALLBACK)

/** 插件 UI 里取当前语言和翻译机制 */
export function useHost(): PluginHostContextValue {
  return useContext(PluginHostContext)
}

/**
 * 常用组合：按当前 locale 从插件自己的词条表里挑一张，返回它的 t()。
 *
 * `tables` 的 key 是语言标签，约定**第一个是插件的默认语言**（作为兜底）。
 * 匹配顺序：精确 -> 只按主语言（en-US 命中 en）-> 默认语言。
 *
 * 注意把 `tables` 定义在模块作用域：写进组件体内的话每次渲染都是新对象，
 * 这个 useMemo 就白做了。
 */
export function usePluginTranslator(tables: Record<string, MessageTable>): LooseTranslator {
  const { locale } = useHost()

  return useMemo(() => {
    const entries = Object.keys(tables)
    const fallbackLocale = entries[0]
    const primary = locale.split('-')[0]

    const byPrimary = entries.find((key) => key.split('-')[0] === primary)
    const table =
      tables[locale] ?? (byPrimary ? tables[byPrimary] : undefined) ?? tables[fallbackLocale]

    return createLooseTranslator(table ?? {})
  }, [locale, tables])
}
