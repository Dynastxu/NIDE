import { useMemo, type JSX, type ReactNode } from 'react'
import { createLooseTranslator } from '@nide/contracts/i18n'
import { PluginHostContext } from './host-context'
import type { PluginHostContextValue } from './host-context'
import { createPluginHostApi } from './plugin-api'
import type { LocaleId, Translator } from '@nide/contracts/i18n'

/**
 * 把宿主的语言、t() 与**受限 API** 注入给插件视图。
 *
 * `pluginId` 决定宿主按哪份权限声明检查调用；它与 `locale` / `t` 一起进
 * `useMemo`，因为它们变一个，插件视图拿到的就应当是另一个对象。
 */
export function PluginHostProvider({
  locale,
  t,
  pluginId,
  children
}: {
  locale: LocaleId
  t: Translator
  /** 清单里的插件 id；渲染宿主自己的组件时传空字符串 */
  pluginId: string
  children: ReactNode
}): JSX.Element {
  const value = useMemo<PluginHostContextValue>(
    () => ({
      locale,
      t,
      createTranslator: createLooseTranslator,
      pluginId,
      api: createPluginHostApi(pluginId)
    }),
    [locale, t, pluginId]
  )

  return <PluginHostContext.Provider value={value}>{children}</PluginHostContext.Provider>
}
