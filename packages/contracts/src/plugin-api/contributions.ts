import type { ViewChromeOptions, ViewLocation } from './view.js'

/**
 * 插件贡献点的**纯数据**契约（host -> shell）。
 *
 * 这一层解决的问题：视图 / 设置页 / 语言包此前是 shell 自己扫 <插件目录>、
 * 读 manifest、读词条文件得到的（`src/main/plugin-host/loader.ts`），而 host 为了
 * 「装了什么、哪个启用、bundle 在哪」又扫了一遍同样的目录。两份实现迟早对不上 ——
 * 现在读盘只在 host，shell 只消费这里的数据。
 *
 * 三条刻意的约束：
 *
 * 1. **不解析语言**。标题保持 manifest 里原样的 `titleSpec`（可能是 `%key%`）：
 *    解析要用当前语言，而语言属于 shell（`src/main/i18n`）。host 只管把词条表
 *    一起送过来，由 shell 在查询时解析。
 * 2. **不带绝对路径**。`dir` 是插件目录名，`entry` 是插件目录内的 POSIX 相对路径
 *    —— dev 与打包后取值一致，也不把用户的磁盘布局泄进描述符。
 * 3. **不 import 任何运行时值**。这个文件会被 host 的纯 Node ESM 直接加载，
 *    所以只能依赖 `./view`（同样无运行时依赖）里的类型。
 */

/** 词条表：扁平 key -> 文案（与 shared/i18n 的 MessageTable 同形，但不引它的运行时） */
export type PluginMessages = Record<string, string>

/** 语言包来源层级：第三方永远优先于内置 */
export type PluginLocaleTier = 'builtin' | 'third-party'

/** 一个插件贡献的视图（manifest `contributes.views[]` 收敛后的形状） */
export interface PluginViewEntry {
  /** 视图 id，例如 'demo.hello' */
  id: string
  /** 贡献它的插件 id，例如 'builtin.demo' */
  pluginId: string
  /** manifest 里**原样**写的标题：普通字符串或 '%some.key%' */
  titleSpec: string
  location: ViewLocation
  icon?: string
  chrome?: ViewChromeOptions
  /** 插件目录名（plugins/builtin/<dir>） */
  dir: string
  /** UI 入口：相对于插件目录的 POSIX 路径 */
  entry: string
}

/** 一个插件贡献的设置页（manifest `contributes.settings[]`） */
export interface PluginSettingsEntry {
  id: string
  pluginId: string
  titleSpec: string
  dir: string
  entry: string
  order: number
}

/** 一个语言包：读进来的词条数据，已经过路径与形状校验 */
export interface PluginLocalePack {
  /** 规范化后的 locale，例如 'en-US' */
  locale: string
  /** 语言的自称（"English"），缺失时由 host 回落成 locale 本身 */
  label: string
  source: PluginLocaleTier
  pluginId: string
  dir: string
  messages: PluginMessages
}

/** 一个插件的 manifest 词条（package.nls*.json），供 shell 按语言解析标题 */
export interface PluginManifestNls {
  /** package.nls.json：插件自己声明的默认语言，最后一档回落 */
  defaultTable?: PluginMessages
  /** locale -> package.nls.<locale>.json，key 已规范化 */
  byLocale: Record<string, PluginMessages>
}

/** host 一次下发的全部插件贡献点 */
export interface PluginContributions {
  views: PluginViewEntry[]
  settings: PluginSettingsEntry[]
  locales: PluginLocalePack[]
  /** pluginId -> 该插件的 manifest 词条；没有词条文件的插件不在表里 */
  manifestNls: Record<string, PluginManifestNls>
}

/** 空集合：host 不可达时 shell 用它兜底（界面只剩内建视图） */
export function emptyPluginContributions(): PluginContributions {
  return { views: [], settings: [], locales: [], manifestNls: {} }
}
