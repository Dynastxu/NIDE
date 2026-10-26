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
 * ## 每个分区是一段映射
 *
 * 四个内容分区各成一段，段里至少有一个 `path`；图鉴那一段多一个 `characters`
 * （角色图鉴的目录名），概述那一段**可以**多 `outline` / `style`（哪份 Markdown 被
 * 标记成大纲 / 写作风格）：
 *
 * ```
 * chapters:
 *   path: "chapters"
 * gallery:
 *   path: "gallery"
 *   characters: "characters"
 * overview:
 *   path: "overview"
 *   outline: "outline.md"
 *   style: "style.md"
 * ```
 *
 * `characters` 原先单独记在 `.nide/gallery.yml` 里，后来合并进这一份。两者都是
 * 项目结构的一部分：分成两份文件时，删掉其中一份就只剩半份配置，而它们改的本来
 * 就是同一件事。旧文件由主进程在读到旧格式时合并一次（见 parseLegacyProjectConfig
 * 与 parseLegacyGalleryRegistry）。
 *
 * `outline` / `style` 是**可选的标记**：概述目录里全是普通 Markdown，没标记时两个键
 * 都不存在；用户标记之后才写进来。旧项目的 config.yml 因此不需要迁移 —— 缺这两个键
 * 就是「还没标记」。缺 `path` 仍然整份作废。
 *
 * YAML 那一档写法（标量与引号）在 `#project/yaml`：章节 Markdown 的 frontmatter 用的是
 * 同一档，两处共用同一份实现，才不会出现「config.yml 读得出、frontmatter 读不出」
 * 这类只在运行时才看得见的分叉。
 */

import { parseYamlScalar, quoteYamlValue } from '#project/yaml'
import { isMarkdownPath } from '#project/files'

/** 配置项：四个内容分区 */
export const PROJECT_CONFIG_KEYS = ['chapters', 'gallery', 'foreshadowing', 'overview'] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

/** 每一段共同的键：这一段自己的目录 */
export const PROJECT_SECTION_PATH_KEY = 'path'

/** 只有图鉴那一段有的键：角色图鉴的目录名 */
export const PROJECT_SECTION_CHARACTERS_KEY = 'characters'

/** 只有概述那一段有的键：哪份 Markdown 是大纲。没标记时没有这个键 */
export const PROJECT_SECTION_OUTLINE_KEY = 'outline'

/** 只有概述那一段有的键：哪份 Markdown 是写作风格。没标记时没有这个键 */
export const PROJECT_SECTION_STYLE_KEY = 'style'

/**
 * 新建项目时自带的大纲文件名。
 *
 * 它不是「缺键时的回落」：概述里没有任何标记时就是没有标记（见 OverviewSection）。
 * 这两个名字只在**新建项目**时用来建出默认的两份文档，并写进配置。
 */
export const DEFAULT_OVERVIEW_OUTLINE_FILE = 'outline.md'

/** 新建项目时自带的写作风格文件名。用途同 DEFAULT_OVERVIEW_OUTLINE_FILE */
export const DEFAULT_OVERVIEW_STYLE_FILE = 'style.md'

/** 一个内容分区：它自己的目录 */
export interface ProjectSection {
  /** 相对项目根的目录路径，段间用 `/` 分隔（见 normalizeConfigDirectory） */
  path: string
}

/** 图鉴分区：目录之外还记着哪一个是角色图鉴 */
export interface GallerySection extends ProjectSection {
  /**
   * 角色图鉴的目录名，相对图鉴目录的一层（见 normalizeDirectorySegment）。
   *
   * 章节表单的出场角色从它里面选。存目录名而不是绝对路径，理由与 `path` 相同：
   * `.nide` 要跟项目一起进版本库，绝对路径换台机器就指向别处。
   */
  characters: string
}

/**
 * 概述分区：目录之外还记着哪两份 Markdown 被标记成「大纲」与「写作风格」。
 *
 * 这两份文件仍然是**普通的 Markdown**（见 ./overview）：标记只回答「获取大纲 / 写作
 * 风格时该读哪个文件」，不改变文件本身，也不影响目录里的其他文件。用户没有标记时
 * 这两个键都不存在；标记之后才写进配置。
 *
 * 值存的是**文件名**（相对概述目录的一层），不是绝对路径：理由与 `path` 相同。
 */
export interface OverviewSection extends ProjectSection {
  /** 大纲的文件名。没有标记时不存在这个键 */
  outline?: string
  /** 写作风格的文件名。没有标记时不存在这个键 */
  style?: string
}

/**
 * 项目配置。
 *
 * 每一段里的 `path` 都是**相对项目根**的目录路径，段间用 `/` 分隔（见
 * normalizeConfigDirectory）。目录名英文，是为了让同一份内容目录在中文、日文、英文
 * 系统上长得一样 —— 显示名该由界面本地化，磁盘上的结构不该随界面语言变。
 */
export interface ProjectConfig {
  /** 章节 */
  chapters: ProjectSection
  /** 图鉴 */
  gallery: GallerySection
  /** 伏笔 */
  foreshadowing: ProjectSection
  /** 概述 */
  overview: OverviewSection
}

/** 默认配置：创建项目时按它建目录，也在配置缺失或读坏时回落 */
export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  chapters: { path: 'chapters' },
  gallery: { path: 'gallery', characters: 'characters' },
  foreshadowing: { path: 'foreshadowing' },
  overview: { path: 'overview' }
}

/** `.nide` 目录名。宿主的项目级数据都在它里面 */
export const PROJECT_META_DIR_NAME = '.nide'

/** 配置文件名（在 `.nide` 之内） */
export const PROJECT_CONFIG_FILE_NAME = 'config.yml'

/**
 * 合并之前的图鉴注册表文件名。
 *
 * 只用于**读取旧项目**：主进程读到旧格式的配置时把它并进 `config.yml`，随后删掉它
 * （见 project-config.service 的 loadProjectConfig）。新项目不会写这份文件。
 */
export const LEGACY_GALLERY_REGISTRY_FILE_NAME = 'gallery.yml'

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
 * 把一个名字收敛成「只有一段的目录名」，校验不过给 null。
 *
 * 复用 normalizeConfigDirectory 再加一条「只有一段」：图鉴的目录名是图鉴内容目录
 * 底下的一层，`卷一/角色` 那样的多段名字在这个位置上没有意义，而放它过去就等于让
 * 配置能指向图鉴目录里的任意一层。
 */
export function normalizeDirectorySegment(raw: string): string | null {
  const normalized = normalizeConfigDirectory(raw)
  if (normalized === null) return null
  if (normalized.includes('/')) return null

  return normalized
}

/**
 * 把一个名字收敛成「概述目录里的一份 Markdown」，校验不过给 null。
 *
 * 复用 `normalizeDirectorySegment` 再加一条「必须是 Markdown」：配置值只能是一层
 * 文件名（`..`、`/`、盘符一律拒绝），而大纲与写作风格按约定是 `.md` / `.markdown`。
 * 非 Markdown 的文件仍然可以放在概述目录里，只是不能被登记成这两个角色。
 */
export function normalizeOverviewFileName(raw: string): string | null {
  const normalized = normalizeDirectorySegment(raw)
  if (normalized === null) return null
  if (!isMarkdownPath(normalized)) return null

  return normalized
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

/**
 * 概述那一段里的一个文件名。
 *
 * 没有标记时是 `undefined`（合法），写了一个坏值（空串、非字符串、`..`、非 Markdown）
 * 时是 `null`（整份配置作废）。与 `path` 不同 —— 这两项本来就是可选的：概述目录里
 * 全是普通 Markdown，标记只是「取大纲 / 写作风格时读哪个文件」。
 */
function overviewFileNameFrom(value: unknown): string | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return null

  return normalizeOverviewFileName(value)
}

/** 逐项校验一份配置。任何一项不合格就返回 null —— **不做逐项回落**（理由见主进程的 loadProjectConfig） */
export function validateProjectConfig(value: unknown): ProjectConfig | null {
  if (!value || typeof value !== 'object') return null

  const source = value as Record<string, unknown>
  const paths = {} as Record<ProjectConfigKey, string>

  for (const key of PROJECT_CONFIG_KEYS) {
    const section = source[key]
    if (!section || typeof section !== 'object' || Array.isArray(section)) return null

    const directory = normalizeConfigDirectory((section as { path?: unknown }).path as string)
    if (directory === null) return null
    paths[key] = directory
  }

  const characters = normalizeDirectorySegment(
    (source.gallery as { characters?: unknown }).characters as string
  )
  if (characters === null) return null

  const overview = source.overview as { outline?: unknown; style?: unknown }
  const outline = overviewFileNameFrom(overview.outline)
  const style = overviewFileNameFrom(overview.style)
  if (outline === null || style === null) return null
  // 两份都标记时必须指向不同的文件：同一个文件不能同时是「大纲」和「写作风格」
  if (outline !== undefined && style !== undefined && outline === style) return null

  const overviewSection: OverviewSection = { path: paths.overview }
  if (outline !== undefined) overviewSection.outline = outline
  if (style !== undefined) overviewSection.style = style

  return {
    chapters: { path: paths.chapters },
    gallery: { path: paths.gallery, characters },
    foreshadowing: { path: paths.foreshadowing },
    overview: overviewSection
  }
}

/**
 * 一个分区的补丁：只放要改的那几项。
 *
 * `characters` 只有图鉴那一段用得上，`outline` / `style` 只有概述那一段用得上；
 * 别的分区即使给了也被当成未知项忽略 —— 补丁是渲染进程给的，这一层不替它猜
 * 「这段是不是图鉴 / 概述」。
 */
export interface ProjectSectionPatch {
  path?: string
  characters?: string
  outline?: string
  style?: string
}

/** 配置补丁：按分区给的那一份 */
export type ProjectConfigPatch = Partial<Record<ProjectConfigKey, ProjectSectionPatch>>

/**
 * 把一份任意载荷收敛成「可用的配置补丁」。
 *
 * IPC 的载荷是渲染进程给的，形状完全不可信：只认 PROJECT_CONFIG_KEYS 里的分区、
 * 分区里只认 path / characters / outline / style 这几个键、只认字符串值，坏的那一项
 * **整条丢掉**（而不是回落成默认值）—— 悄悄替用户改成别的目录比拒绝这次改动更难解释。
 */
export function sanitizeProjectConfigPatch(value: unknown): ProjectConfigPatch {
  if (!value || typeof value !== 'object') return {}

  const source = value as Record<string, unknown>
  const patch: ProjectConfigPatch = {}

  for (const key of PROJECT_CONFIG_KEYS) {
    const section = source[key]
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue

    const fields = section as Record<string, unknown>
    const entry: ProjectSectionPatch = {}
    if (typeof fields[PROJECT_SECTION_PATH_KEY] === 'string') {
      entry.path = fields[PROJECT_SECTION_PATH_KEY] as string
    }
    if (key === 'gallery' && typeof fields[PROJECT_SECTION_CHARACTERS_KEY] === 'string') {
      entry.characters = fields[PROJECT_SECTION_CHARACTERS_KEY] as string
    }
    if (key === 'overview') {
      if (typeof fields[PROJECT_SECTION_OUTLINE_KEY] === 'string') {
        entry.outline = fields[PROJECT_SECTION_OUTLINE_KEY] as string
      }
      if (typeof fields[PROJECT_SECTION_STYLE_KEY] === 'string') {
        entry.style = fields[PROJECT_SECTION_STYLE_KEY] as string
      }
    }

    if (
      entry.path !== undefined ||
      entry.characters !== undefined ||
      entry.outline !== undefined ||
      entry.style !== undefined
    ) {
      patch[key] = entry
    }
  }

  return patch
}

/** 校验与应用的结论。界面据此说明「哪一项没被接受」 */
export interface ProjectConfigApplyResult {
  ok: boolean
  config: ProjectConfig
  /** 被拒绝的分区：段里有值不是合法的相对目录路径 / 角色图鉴名 / 概述文件名 */
  rejected: ProjectConfigKey[]
  /** 被拒绝的分区里，路径指向 `.nide` 内部的那些 */
  conflicts: ProjectConfigKey[]
}

/**
 * 把补丁应用到一份配置上。
 *
 * 两种情形都拒绝：路径不合法（逃出项目根、空路径、多段的角色图鉴名），以及路径
 * 指向 `.nide` 内部。一个分区里只要有一项不合格，这个分区就整段不改 —— 而返回的
 * `config` 在**全部分区都合格**时才替换，否则原样返回：一次改动留下一半生效的配置，
 * 比整条拒绝更难查。
 */
export function applyProjectConfigPatch(
  current: ProjectConfig,
  patch: ProjectConfigPatch
): ProjectConfigApplyResult {
  const rejected: ProjectConfigKey[] = []
  const conflicts: ProjectConfigKey[] = []
  const next: ProjectConfig = { ...current, gallery: { ...current.gallery } }

  for (const key of PROJECT_CONFIG_KEYS) {
    const sectionPatch = patch[key]
    if (!sectionPatch) continue

    let directory = current[key].path
    if (sectionPatch.path !== undefined) {
      const normalized = normalizeConfigDirectory(sectionPatch.path)
      if (normalized === null) {
        rejected.push(key)
        continue
      }

      if (isMetaDirectoryPath(normalized)) {
        conflicts.push(key)
        continue
      }

      directory = normalized
    }

    if (key === 'gallery') {
      let characters = current.gallery.characters
      if (sectionPatch.characters !== undefined) {
        const normalized = normalizeDirectorySegment(sectionPatch.characters)
        if (normalized === null) {
          rejected.push(key)
          continue
        }

        characters = normalized
      }

      next.gallery = { path: directory, characters }
      continue
    }

    if (key === 'overview') {
      let outline = current.overview.outline
      let style = current.overview.style

      if (sectionPatch.outline !== undefined) {
        const normalized = normalizeOverviewFileName(sectionPatch.outline)
        if (normalized === null) {
          rejected.push(key)
          continue
        }

        outline = normalized
      }

      if (sectionPatch.style !== undefined) {
        const normalized = normalizeOverviewFileName(sectionPatch.style)
        if (normalized === null) {
          rejected.push(key)
          continue
        }

        style = normalized
      }

      // 两份都标记时必须指向不同的文件：同一个文件不能同时是「大纲」和「写作风格」
      if (outline !== undefined && style !== undefined && outline === style) {
        rejected.push(key)
        continue
      }

      const overviewSection: OverviewSection = { path: directory }
      if (outline !== undefined) overviewSection.outline = outline
      if (style !== undefined) overviewSection.style = style
      next.overview = overviewSection
      continue
    }

    next[key] = { path: directory }
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
  /** 更新当前项目配置（invoke），参数是项目根 + 只含已知分区的补丁 */
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
 * config.yml 的写法：**只有两层的映射**，每个值都是字符串。
 *
 * 标量与引号那一档实现在 `#project/yaml`（章节 frontmatter 用的是同一档）。这里只留
 * 本文件特有的三样：落盘顺序、缩进与注释头。手改过的 config.yml 用了锚点、多行块、
 * 流式集合这类结构时判为坏配置，由调用方回落成默认值（见 loadProjectConfig）。
 */

/** 每一段里子键的缩进。写出来的文件固定两格，读的时候只要求「比顶层深」 */
const YAML_SECTION_INDENT = '  '

/** 配置文件的注释头。写出来的第一行永远是它 */
const YAML_HEADER = '# NIDE project configuration\n# Paths are relative to the project root.\n'

/**
 * 一段配置该落盘哪些子键，按这个顺序。
 *
 * 顺序写死（而不是按对象键的顺序）是为了让写出来的文件**每次都是同一份**：磁盘上
 * 那份与这里写出来的等价时，主进程就不再碰它（见 writeProjectConfig）。
 */
function sectionEntries(key: ProjectConfigKey, config: ProjectConfig): [string, string][] {
  const entries: [string, string][] = [[PROJECT_SECTION_PATH_KEY, config[key].path]]
  if (key === 'gallery') {
    entries.push([PROJECT_SECTION_CHARACTERS_KEY, config.gallery.characters])
  }
  if (key === 'overview') {
    if (config.overview.outline !== undefined) {
      entries.push([PROJECT_SECTION_OUTLINE_KEY, config.overview.outline])
    }
    if (config.overview.style !== undefined) {
      entries.push([PROJECT_SECTION_STYLE_KEY, config.overview.style])
    }
  }

  return entries
}

/** 按分区顺序序列化一份配置 */
export function serializeProjectConfig(config: ProjectConfig): string {
  const lines: string[] = []

  for (const key of PROJECT_CONFIG_KEYS) {
    lines.push(`${key}:`)
    for (const [field, value] of sectionEntries(key, config)) {
      lines.push(`${YAML_SECTION_INDENT}${field}: ${quoteYamlValue(value)}`)
    }
  }

  return `${YAML_HEADER}${lines.join('\n')}\n`
}

/** 一行 `键: 值`。值里只去掉两端的空白，引号与注释留给调用方判 */
function splitConfigLine(line: string): { name: string; raw: string } | null {
  const separator = line.indexOf(':')
  if (separator <= 0) return null

  return { name: line.slice(0, separator).trim(), raw: line.slice(separator + 1).trim() }
}

/**
 * 读 config.yml，读不出来给 null。
 *
 * 只认本模块写出来的那一档：顶层的四个分区各写一次键、值在它底下缩进的那一段里。
 * 因此**未知的顶层键**（别人往里写的东西）连同它的子键一起被忽略，而**缺一个键**
 * 就整份作废 —— 「补上默认值」等于承认一份残缺的文件是有效的，之后所有读者都要
 * 再防一遍。
 *
 * 与合并之前那一版（四项都是扁平标量）的差别放在 parseLegacyProjectConfig 里：这里
 * 读不出来的文件还有一次按旧格式读的机会，两份函数都不认时才判为坏配置。
 */
export function parseProjectConfig(text: string): ProjectConfig | null {
  if (typeof text !== 'string') return null

  /** 每个分区收到的那几个子键。不认得的分区也建一个，缩进行才有归属 */
  const sections = new Map<ProjectConfigKey, Record<string, string>>()
  let current: Record<string, string> | null = null

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()

    // 空行与注释行（含写出来的那两行注释头）
    if (line.length === 0 || line.startsWith('#')) continue

    const field = splitConfigLine(line)
    if (field === null) return null

    // `键: # 说明` 与 `键:` 是同一件事：值没写。行尾注释不是本模块写出来的那一档，
    // 但把它读成一个值（注释文字会变成目录名）比判成空值糟得多
    const raw = field.raw.startsWith('#') ? '' : field.raw

    if (/^\s/.test(rawLine)) {
      // 缩进的行属于上一个分区；没有分区可归属时说明这不是本模块写出来的文件
      if (current === null || field.name.length === 0) return null

      const value = parseYamlScalar(raw)
      if (value === null) return null

      current[field.name] = value
      continue
    }

    /**
     * 顶层的一行。不认得的分区整个跳过：`current` 指向一个不落盘的临时对象，它底下
     * 缩进的那些行因此既不算进别的分区、也不会让整份文件作废。
     */
    if (!isProjectConfigKey(field.name)) {
      current = {}
      continue
    }

    // 已知的分区写成了标量：那是合并之前那一版的写法，交给旧格式那一份去读
    if (raw.length > 0) return null

    current = {}
    sections.set(field.name, current)
  }

  const paths = {} as Record<ProjectConfigKey, string>

  for (const key of PROJECT_CONFIG_KEYS) {
    const section = sections.get(key)
    if (!section) return null

    const directory = normalizeConfigDirectory(section[PROJECT_SECTION_PATH_KEY] ?? '')
    if (directory === null) return null
    paths[key] = directory
  }

  const characters = normalizeDirectorySegment(
    sections.get('gallery')?.[PROJECT_SECTION_CHARACTERS_KEY] ?? ''
  )
  if (characters === null) return null

  const overview = sections.get('overview')
  const outline = overviewFileNameFrom(overview?.[PROJECT_SECTION_OUTLINE_KEY])
  const style = overviewFileNameFrom(overview?.[PROJECT_SECTION_STYLE_KEY])
  if (outline === null || style === null) return null
  if (outline !== undefined && style !== undefined && outline === style) return null

  const overviewSection: OverviewSection = { path: paths.overview }
  if (outline !== undefined) overviewSection.outline = outline
  if (style !== undefined) overviewSection.style = style

  return {
    chapters: { path: paths.chapters },
    gallery: { path: paths.gallery, characters },
    foreshadowing: { path: paths.foreshadowing },
    overview: overviewSection
  }
}

// ============ 旧格式（合并之前的两份文件） ============

/**
 * 合并之前那一版 `config.yml`：四项都是扁平标量。
 *
 * ```
 * chapters: "chapters"
 * gallery: "gallery"
 * ```
 *
 * 只用于迁移：主进程读到这种写法时，把它和 `.nide/gallery.yml` 合成一份新的配置
 * 写回去（见 loadProjectConfig）。新项目不会写出这种形状。
 */
export interface LegacyProjectConfig {
  chapters: string
  gallery: string
  foreshadowing: string
  overview: string
}

/** 读旧版 `config.yml`（扁平四项），读不出来给 null */
export function parseLegacyProjectConfig(text: string): LegacyProjectConfig | null {
  if (typeof text !== 'string') return null

  const values: Partial<Record<ProjectConfigKey, string>> = {}

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()

    if (line.length === 0 || line.startsWith('#')) continue

    // 顶格之外的东西说明这不是旧版写出来的那份文件
    if (/^\s/.test(rawLine)) return null

    const field = splitConfigLine(line)
    if (field === null) return null
    if (!isProjectConfigKey(field.name)) continue

    const value = parseYamlScalar(field.raw)
    if (value === null) return null

    values[field.name] = value
  }

  const paths = {} as Record<ProjectConfigKey, string>
  for (const key of PROJECT_CONFIG_KEYS) {
    const directory = normalizeConfigDirectory(values[key] ?? '')
    if (directory === null) return null
    paths[key] = directory
  }

  return {
    chapters: paths.chapters,
    gallery: paths.gallery,
    foreshadowing: paths.foreshadowing,
    overview: paths.overview
  }
}

/**
 * 读旧版 `.nide/gallery.yml`（图鉴注册表），读不出来给 null。
 *
 * ```
 * characters: "characters"
 * ```
 *
 * 与 parseLegacyProjectConfig 同一条理由：只用于迁移，新项目不会写出这份文件。
 */
export function parseLegacyGalleryRegistry(text: string): string | null {
  if (typeof text !== 'string') return null

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()

    if (line.length === 0 || line.startsWith('#')) continue

    // 顶格之外的东西说明这不是旧版写出来的那份文件
    if (/^\s/.test(rawLine)) return null

    const field = splitConfigLine(line)
    if (field === null) return null
    if (field.name !== PROJECT_SECTION_CHARACTERS_KEY) continue

    const value = parseYamlScalar(field.raw)
    if (value === null) return null

    return normalizeDirectorySegment(value)
  }

  return null
}
