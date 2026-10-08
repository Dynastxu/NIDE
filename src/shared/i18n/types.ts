/**
 * 本地化的公共类型。
 *
 * 这一层被主进程和渲染进程共用，所以**不能** import electron / DOM 里的任何东西。
 */

/** BCP-47 语言标签。项目内部统一用规范化后的大小写形式，例如 "zh-CN" / "en-US"。 */
export type LocaleId = string

/**
 * 语言包来源层级。
 *
 * 冲突时**第三方优先**：用户装的语言包一定盖得住宿主内置的那份。
 * 顺序即优先级，后面合并的覆盖前面的。
 */
export type LocaleSourceTier = 'builtin' | 'third-party'

export const TIER_PRIORITY: Record<LocaleSourceTier, number> = {
  builtin: 0,
  'third-party': 1
}

/**
 * 词条表：**扁平的点号 key** -> 文案，占位符写成 `{name}`。
 *
 * 用扁平 key 而不是嵌套对象，是因为语言包要做「key 集合」比对来暴露漏翻，
 * 扁平结构下这就是两次 Set 差集，不需要递归展平。
 */
export type MessageTable = Record<string, string>

/** manifest.json 的 contributes.locales 里的一条 */
export interface LocaleContribution {
  /** 这个包提供哪个语言的翻译，例如 "en-US" */
  locale: LocaleId
  /**
   * 语言在**语言选择列表**里显示的名字。
   * 约定：自描述 —— 用该语言自己的写法（"English" / "日本語" / "简体中文"），
   * 不参与翻译体系。否则就会出现「翻『语言』这个词本身」的循环。
   */
  label: string
  /** 词条文件，相对于插件目录的 POSIX 路径，例如 "locales/en-US.json" */
  file: string
}

/** 主进程扫描完语言包后、可以展示给用户的一条记录 */
export interface LocaleDescriptor {
  locale: LocaleId
  label: string
  source: LocaleSourceTier
  /** 提供它的插件，例如 "builtin.lang-en" */
  pluginId: string
  /** 插件目录名，便于排查 */
  dir: string
}

/** 同一个 locale 被多个包提供、且同一个 key 给出了不同译文 */
export interface LocaleConflict {
  locale: LocaleId
  key: string
  /** 最终生效的那个包 */
  winner: LocaleProviderRef
  /** 被盖掉的那个包 */
  loser: LocaleProviderRef
}

export interface LocaleProviderRef {
  pluginId: string
  source: LocaleSourceTier
}

/**
 * 漏翻体检结果。
 *
 * 第三方语言包的 TS 类型是**管不到**的（它在运行时才从磁盘读进来），
 * 所以「漏翻」只能靠运行时比对 key 集合来暴露，这份报告就是出口。
 */
export interface LocaleDiagnostics {
  locale: LocaleId
  /** 语言包没翻、最终回落成中文的 key */
  missing: string[]
  /** 语言包里多出来的 key：宿主已删除或作者拼错 */
  extra: string[]
  conflicts: LocaleConflict[]
}

/** 主进程 -> 渲染进程 的完整 i18n 载荷（纯数据，可结构化克隆） */
export interface I18nPayload {
  /** 最终生效的语言 */
  locale: LocaleId
  /** 合并后的词条表：中文基础表 <- 内置语言包 <- 第三方语言包 */
  messages: MessageTable
  /** 所有可切换的语言，已按 label 排序 */
  available: LocaleDescriptor[]
  /**
   * 用户请求的语言没有对应语言包时，这里记录被放弃的那个 locale。
   * 有值就说明发生了回落，界面应当给出可见提示。
   */
  fallbackFrom?: LocaleId
  diagnostics: LocaleDiagnostics
}
