/**
 * 语言标签的规范化与候选链。
 *
 * 单独成一个文件，是因为它要同时被两边加载：
 * - shell 的 i18n（`./index.ts` 再导出它，界面与翻译都走这里）；
 * - host 的插件贡献点读取（`packages/host/src/services/plugin-contributions.ts`），
 *   manifest 词条文件名里的 locale 要在 host 侧就规范化好。
 *
 * host 是纯 Node ESM，只能直接加载**本目录里没有其它 import 的文件** ——
 * `./index.ts` 要 `zhCN` 词条表（webpack 风格的无扩展名相对导入 Node 不认），
 * 所以这一个文件不许 import 任何东西。`./package.json` 的 `{"type":"module"}`
 * 是给 Node 看的模块标记。
 */

/** 没有语言包、也没有系统语言可用时的最终回落 */
export const DEFAULT_LOCALE = 'zh-CN'

/**
 * 把任意写法的语言标签规范化成项目内部的形式。
 *
 * 规则：语言小写、两位的地区码大写、四位（Script）首字母大写其余小写，
 * 其余部分小写；下划线视同连字符；空串回落成默认语言。
 *
 * "en_us" -> "en-US"、"zh-hans-cn" -> "zh-Hans-CN"、"EN" -> "en"
 */
export function normalizeLocale(tag: string): string {
  const parts = String(tag ?? '')
    .replace(/_/g, '-')
    .split('-')
    .filter(Boolean)

  if (parts.length === 0) return DEFAULT_LOCALE

  const [lang, ...rest] = parts
  return [
    lang.toLowerCase(),
    ...rest.map((part) => {
      if (part.length === 2) return part.toUpperCase()
      if (part.length === 4) return part[0].toUpperCase() + part.slice(1).toLowerCase()
      return part.toLowerCase()
    })
  ].join('-')
}

/**
 * 从具体到宽泛的匹配候选。
 *
 * "zh-Hans-CN" -> ["zh-Hans-CN", "zh-Hans", "zh"]
 *
 * 这样只提供 "en" 的语言包也能接住 "en-GB" 的请求，作者不必为每个地区复制一份。
 */
export function localeCandidates(tag: string): string[] {
  const normalized = normalizeLocale(tag)
  const parts = normalized.split('-')
  const out: string[] = []
  for (let i = parts.length; i > 0; i--) {
    out.push(parts.slice(0, i).join('-'))
  }
  return out
}
