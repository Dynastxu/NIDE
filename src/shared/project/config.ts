/**
 * `.nide` 项目配置的契约：配置形状、默认值、校验、以及 config.yml 的读写文本。
 *
 * 这一层被主进程（落盘）与渲染进程（消费配置）共用，所以**不能** import
 * electron / fs / DOM：这里只有纯函数，测试不必起 electron，也不必碰盘。
 * 「什么时候建目录、坏配置怎么回落」留给主进程的 project-config.service。
 *
 * 配置里只放**相对项目根**的路径。绝对路径一旦落盘，项目被移动或换一台机器就
 * 指向了别处，而这份文件是要跟项目一起进版本库的。
 *
 * YAML 那一档写法（标量与引号）在 `@shared/yaml`：章节 Markdown 的 frontmatter 用的是
 * 同一档，两处共用同一份实现，才不会出现「config.yml 读得出、frontmatter 读不出」
 * 这类只在运行时才看得见的分叉。
 */

import { parseYamlScalar, quoteYamlValue } from '@shared/yaml'

/** 配置项：四个内容目录 */
export const PROJECT_CONFIG_KEYS = ['chapters', 'gallery', 'foreshadowing', 'overview'] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

/**
 * 项目配置。
 *
 * 每一项都是**相对项目根**的目录路径，段间用 `/` 分隔（见 normalizeConfigDirectory）。
 * 目录名英文，是为了让同一份内容目录在中文、日文、英文系统上长得一样 —— 显示名
 * 该由界面本地化，磁盘上的结构不该随界面语言变。
 */
export interface ProjectConfig {
  /** 章节 */
  chapters: string
  /** 图鉴 */
  gallery: string
  /** 伏笔 */
  foreshadowing: string
  /** 概述 */
  overview: string
}

/** 默认配置：创建项目时按它建目录，也在配置缺失或读坏时回落 */
export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  chapters: 'chapters',
  gallery: 'gallery',
  foreshadowing: 'foreshadowing',
  overview: 'overview'
}

/** `.nide` 目录名。宿主的项目级数据都在它里面 */
export const PROJECT_META_DIR_NAME = '.nide'

/** 配置文件名（在 `.nide` 之内） */
export const PROJECT_CONFIG_FILE_NAME = 'config.yml'

/**
 * `.nide` 自己的忽略文件名。
 *
 * 目前**不忽略任何文件**：先把这份文件建出来，是为了让「哪些东西不该进版本库」
 * 有一个固定的落点 —— 将来 `.nide` 里出现缓存、索引这类产物时，写在这里而不是
 * 散在项目根的 .gitignore 里。
 */
export const PROJECT_META_IGNORE_FILE_NAME = '.gitignore'

/** `.nide/.gitignore` 的初始内容：一行说明，不忽略任何东西 */
export const DEFAULT_PROJECT_META_IGNORE = '# NIDE project metadata\n# Nothing is ignored yet.\n'

/** 配置键的判定，供解析载荷与 YAML 词条共用 */
export function isProjectConfigKey(value: string): value is ProjectConfigKey {
  return (PROJECT_CONFIG_KEYS as readonly string[]).includes(value)
}

/**
 * 把一个配置里的目录路径收敛成「相对项目根、以 `/` 分段」的写法，校验不过给 null。
 *
 * 拒绝的形状都是**会逃出项目根**或让落盘路径失去意义的那几种：空路径、`/` 开头的
 * 绝对路径、Windows 盘符（`C:`）、`..` 段落（可以指到项目外）、空段落（`a//b`）。
 * 反斜杠按分隔符处理并收敛成 `/`：配置是人手改得动的，Windows 上习惯写
 * `chapters\volume-1`。副作用是「名字里真的有反斜杠」无法表达 —— 那样的目录在
 * Windows 上也建不出来，与其留下一个各平台表现不同的值，不如把它当分隔符。
 *
 * 以点开头的段落（`.hidden`）是允许的 —— 用户可能真的想要一个隐藏目录，而这一层
 * 不负责替界面决定「看不见的目录等于没建」。`.nide` 自己另有守卫（见
 * isMetaDirectoryPath），不靠这条规则。
 */
export function normalizeConfigDirectory(raw: string): string | null {
  if (typeof raw !== 'string') return null

  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (trimmed.includes('\0')) return null

  // 反斜杠先当分隔符：Windows 上写出来的路径在 Linux 上也要能读
  const unified = trimmed.replace(/\\/g, '/')

  // 绝对路径与盘符路径：落盘之后会指向项目之外，而项目被移动时它不会跟着走
  if (unified.startsWith('/')) return null
  if (/^[a-zA-Z]:/.test(unified)) return null

  const segments: string[] = []
  for (const segment of unified.split('/')) {
    // 空段落（`a//b`、末尾的 `/`）与 `..` 一律拒绝：前者说明路径不是规范写法，
    // 后者能指到项目之外
    if (segment.length === 0 || segment === '.' || segment === '..') return null
    segments.push(segment)
  }

  return segments.join('/')
}

/**
 * 这个相对路径是不是宿主自己的元数据目录（`.nide` 或它内部的东西）。
 *
 * 用配置把 `chapters` 指到 `.nide` 里是能写进去、也能读出来的 —— 那样宿主就会把
 * 用户的内容目录建在自己的配置目录里。这一层只判定，是否拒绝由调用方决定。
 */
export function isMetaDirectoryPath(relativePath: string): boolean {
  const normalized = normalizeConfigDirectory(relativePath)
  if (normalized === null) return false

  const first = normalized.split('/')[0]
  return first === PROJECT_META_DIR_NAME
}

/** 逐项校验一份配置。任何一项不合格就返回 null —— **不做逐项回落**（理由见主进程的 loadProjectConfig） */
export function validateProjectConfig(value: unknown): ProjectConfig | null {
  if (!value || typeof value !== 'object') return null

  const source = value as Record<string, unknown>
  const config = {} as ProjectConfig

  for (const key of PROJECT_CONFIG_KEYS) {
    const directory = normalizeConfigDirectory(source[key] as string)
    if (directory === null) return null
    config[key] = directory
  }

  return config
}

/**
 * 把一份任意载荷收敛成「可用的配置补丁」。
 *
 * IPC 的载荷是渲染进程给的，形状完全不可信：只认 PROJECT_CONFIG_KEYS 里的键，
 * 只认非空字符串值，坏的那一项**整条丢掉**（而不是回落成默认值）——
 * 悄悄替用户改成别的目录比拒绝这次改动更难解释。
 */
export function sanitizeProjectConfigPatch(value: unknown): Partial<ProjectConfig> {
  if (!value || typeof value !== 'object') return {}

  const source = value as Record<string, unknown>
  const patch: Partial<ProjectConfig> = {}

  for (const key of PROJECT_CONFIG_KEYS) {
    if (typeof source[key] !== 'string') continue
    patch[key] = source[key] as string
  }

  return patch
}

/** 校验与应用的结论。界面据此说明「哪一项没被接受」 */
export interface ProjectConfigApplyResult {
  ok: boolean
  config: ProjectConfig
  /** 被拒绝的键：值不是合法的相对目录路径 */
  rejected: ProjectConfigKey[]
  /** 被拒绝的键里，值指向 `.nide` 内部的那些 */
  conflicts: ProjectConfigKey[]
}

/**
 * 把补丁应用到一份配置上。
 *
 * 两项都拒绝：路径不合法（逃出项目根、空路径），以及指向 `.nide` 内部的路径。
 * 返回的 `config` 在**全部**合格时才替换，否则原样返回 —— 一次改动留下一半生效
 * 的配置，比整条拒绝更难查。
 */
export function applyProjectConfigPatch(
  current: ProjectConfig,
  patch: Partial<ProjectConfig>
): ProjectConfigApplyResult {
  const rejected: ProjectConfigKey[] = []
  const conflicts: ProjectConfigKey[] = []
  const next = { ...current }

  for (const key of PROJECT_CONFIG_KEYS) {
    const raw = patch[key]
    if (raw === undefined) continue

    const directory = normalizeConfigDirectory(raw)
    if (directory === null) {
      rejected.push(key)
      continue
    }

    if (isMetaDirectoryPath(directory)) {
      conflicts.push(key)
      continue
    }

    next[key] = directory
  }

  const ok = rejected.length === 0 && conflicts.length === 0
  return { ok, config: ok ? next : current, rejected, conflicts }
}

// ============ IPC ============

/**
 * 项目配置的 IPC 通道名。
 *
 * 和其它通道一样集中在这里：拼错通道名没有编译错误，只会在运行时静默失效。
 */
export const PROJECT_CONFIG_CHANNELS = {
  /** 读当前项目配置（invoke），参数是项目根绝对路径 */
  read: 'host:project-read-config',
  /** 更新当前项目配置（invoke），参数是项目根 + 只含已知键的补丁 */
  update: 'host:project-update-config'
} as const

/** 校验不通过时被拒的项 */
export interface ProjectConfigRejection {
  /** 值不是合法的相对目录路径 */
  rejected: ProjectConfigKey[]
  /** 值指向 `.nide` 内部（宿主的元数据目录，不当内容目录用） */
  conflicts: ProjectConfigKey[]
}

/**
 * 更新配置的结果。
 *
 * `ok: false` 时 `config` 是**没有被改动**的那一份：校验不合格是一项都不写
 * （见 applyProjectConfigPatch），界面拿到的始终是磁盘上真实的配置。
 */
export type ProjectConfigUpdateResult =
  | ({ ok: true; config: ProjectConfig } & { rejected: []; conflicts: [] })
  | ({ ok: false; config: ProjectConfig } & ProjectConfigRejection)

// ============ config.yml 的文本读写 ============

/**
 * config.yml 的写法：**只有顶层、只有字符串**。
 *
 * 标量与引号那一档实现在 `@shared/yaml`（章节 frontmatter 用的是同一档）。这里只留
 * 本文件特有的两样：落盘顺序与注释头。手改过的 config.yml 用了锚点、多行块、嵌套
 * 映射这类结构时判为坏配置，由调用方回落成默认值（见 loadProjectConfig）。
 */

/** 要落盘的字段顺序，与默认配置一致：写出来的文件每次都是同一份 */
const YAML_FIELD_ORDER = PROJECT_CONFIG_KEYS

/** 配置文件的注释头。写出来的第一行永远是它 */
const YAML_HEADER = '# NIDE project configuration\n# Paths are relative to the project root.\n'

/** 按字段顺序序列化一份配置 */
export function serializeProjectConfig(config: ProjectConfig): string {
  const lines = YAML_FIELD_ORDER.map((key) => `${key}: ${quoteYamlValue(config[key])}`)

  return `${YAML_HEADER}${lines.join('\n')}\n`
}

/**
 * 解析 config.yml，读不出来给 null。
 *
 * 只做两件事：把每行拆成 `键: 值`，再把值交给 validateProjectConfig。因此
 * **未知的键**（别人往里写的东西）被忽略，而**缺一个键**就整份作废 ——
 * 「补上默认值」等于承认一份残缺的文件是有效的，之后所有读者都要再防一遍。
 */
export function parseProjectConfig(text: string): ProjectConfig | null {
  if (typeof text !== 'string') return null

  const values: Partial<Record<ProjectConfigKey, string>> = {}

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()

    // 空行与注释行（含写出来的那两行注释头）
    if (line.length === 0 || line.startsWith('#')) continue

    // 顶格之外的东西说明这不是本模块写出来的那份文件
    if (/^\s/.test(rawLine)) return null

    const separator = line.indexOf(':')
    if (separator <= 0) return null

    const key = line.slice(0, separator).trim()
    if (!isProjectConfigKey(key)) continue

    const value = parseYamlScalar(line.slice(separator + 1).trim())
    if (value === null) return null

    values[key] = value
  }

  return validateProjectConfig(values)
}
