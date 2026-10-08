import { useMemo, type JSX, type ReactNode } from 'react'
import { createLooseTranslator } from '@shared/i18n'
import { PluginHostContext } from './host-context'
import type { PluginHostContextValue } from './host-context'
import type { LocaleId, Translator } from '@shared/i18n'

/**
 * 把宿主的语言和 t() 注入给插件视图。
 *
 * 单独一个文件只导出一个组件：React Fast Refresh 要求组件文件不夹带其他导出，
 * 否则改一下 hook 就得整页刷新。hook 都在 host-context.ts 里。
 */
export function PluginHostProvider({
  locale,
  t,
  children
}: {
  locale: LocaleId
  t: Translator
  children: ReactNode
}): JSX.Element {
  // useMemo 稳住引用：插件视图常把 context 放进 useEffect 依赖数组，
  // 每次渲染都换新对象会让它们在语言没变时也反复重跑。
  const value = useMemo<PluginHostContextValue>(
    () => ({ locale, t, createTranslator: createLooseTranslator }),
    [locale, t]
  )

  return <PluginHostContext.Provider value={value}>{children}</PluginHostContext.Provider>
}
