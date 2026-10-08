import { zhCN } from './locales/zh-CN'
import type { LocaleId, MessageTable } from './types'

export * from './types'
export { zhCN }

/**
 * 宿主的中文基础表 —— 兜底地板。
 *
 * 语言包再怎么缺，交集也一定包含这份表，所以界面上永远不会出现裸 key。
 */
export const BASE_MESSAGES: MessageTable = zhCN

/** 没有语言包、也没有系统语言可用时的最终回落 */
export const DEFAULT_LOCALE: LocaleId = 'zh-CN'

/**
 * 启动参数前缀：主进程建窗时把语言喂进渲染进程的 `process.argv`。
 *
 * 放在 shared 是因为它是一条**跨进程契约** —— 主进程（window.ts）负责写，
 * preload 负责读，两边必须用同一个字面量。
 */
export const LOCALE_ARG_PREFIX = '--nide-locale='

/**
 * 宿主自己的合法 key 集合。
 *
 * 这是**编译期**保证：宿主代码里 `t('host.xxx')` 拼错直接 typecheck 失败。
 * 第三方语言包的 key 只能运行时比对（见 LocaleDiagnostics）。
 */
export type HostMessageKey = keyof typeof zhCN

/** 占位符参数，对应文案里的 `{name}` */
export type MessageParams = Record<string, string | number>

export type Translator = (key: HostMessageKey, params?: MessageParams) => string

/**
 * 插件用的宽松翻译函数：key 是任意字符串。
 *
 * 和宿主的 t() 只差 key 的类型。之所以必须放宽，是因为插件的词条表**不在**
 * `keyof typeof zhCN` 这个 schema 里 —— 宿主无从校验别的插件的文案，
 * 那份保证只能由插件自己的仓库提供。
 */
export type LooseTranslator = (key: string, params?: MessageParams) => string

/** 把 `{name}` 替换掉。未提供的占位符原样保留，方便一眼看出是漏传了参数。 */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * 基于一张（已经合并好的）词条表造一个 `t()`。
 *
 * 查表顺序：传入的表 -> 中文基础表 -> key 本身。
 * 最后一档回落成 key 是刻意的：漏翻会**显眼地**出现在界面上，而不是静默变空。
 */
export function createTranslator(messages: MessageTable): Translator {
  return (key, params) => {
    const template = messages[key] ?? BASE_MESSAGES[key] ?? key
    return interpolate(template, params)
  }
}

/**
 * 基于**插件自己**的词条表造一个 t()。
 *
 * 回落链刻意只有插件自己的表，最后落到 key 本身：
 * 插件文案不该回落到宿主的中文，那只会让界面变成中英混排，
 * 而且掩盖了「这个插件漏翻」这个事实。插件想回落就回落到**自己的**默认语言。
 *
 * 插值规则和宿主一致，所以插件不需要自己实现一遍 {name} 替换。
 */
export function createLooseTranslator(messages: MessageTable): LooseTranslator {
  return (key, params) => interpolate(messages[key] ?? key, params)
}

/**
 * 把任意来源的语言标签规范化成项目内部形式：语言小写、地区大写、脚本首字母大写。
 *
 * 来源五花八门：`app.getLocale()` 给 "zh-CN"，系统语言可能是 "zh-Hans-CN"，
 * 插件作者可能写 "zh_CN" 或 "EN_us"。统一在入口处收敛，别让大小写问题散到各处。
 */
export function normalizeLocale(tag: string): LocaleId {
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
export function localeCandidates(tag: string): LocaleId[] {
  const normalized = normalizeLocale(tag)
  const parts = normalized.split('-')
  const out: LocaleId[] = []
  for (let i = parts.length; i > 0; i--) {
    out.push(parts.slice(0, i).join('-'))
  }
  return out
}

/**
 * Monaco 自带的 locale 文件名（`monaco-editor/nls/lang/<x>.js`）。
 *
 * **没有 en**：英文是 Monaco 的内建默认，不存在语言文件。
 * 这意味着「英文作为语言包」在 Monaco 这块是零成本的，而「中文为默认」反而要
 * 额外加载 —— 方向和我们自己的语言包体系是相反的。
 */
const MONACO_LOCALE_FILES: ReadonlySet<string> = new Set([
  'cs',
  'de',
  'es',
  'fr',
  'it',
  'ja',
  'ko',
  'pl',
  'pt-br',
  'ru',
  'tr',
  'zh-cn',
  'zh-tw'
])

/**
 * 把项目 locale 映射成 Monaco 的 locale 文件名；返回 null 表示用 Monaco 内建英文。
 *
 * 这一步是**必要的翻译层**：项目里统一 BCP-47（"zh-CN"），Monaco 要小写（"zh-cn"）。
 * 不做这层映射的话，`toLowerCase()` 会散落到调用点各处。
 */
export function toMonacoLocale(locale: LocaleId): string | null {
  const normalized = normalizeLocale(locale).toLowerCase()

  // 繁体在前：zh-Hant / zh-TW / zh-HK 都该拿 zh-tw，不能被下面的 startsWith('zh') 吞掉
  if (normalized === 'zh-tw' || normalized === 'zh-hk' || normalized === 'zh-hant') return 'zh-tw'
  if (normalized.startsWith('zh')) return 'zh-cn'

  return MONACO_LOCALE_FILES.has(normalized) ? normalized : null
}
