import { parseYamlTextValue, quoteYamlValue } from '@shared/yaml'
import { baseNameOf, extensionOf } from './files'
import { DEFAULT_PROJECT_CONFIG, normalizeDirectorySegment } from './config'
import { parseDocumentFields, type FrontmatterCell } from './frontmatter'
import type { CreateEntryFailureReason, DirReadFailureReason } from './files'

/**
 * 图鉴的契约：一个图鉴是什么、它的字段从哪儿来、条目文件长什么样。
 *
 * ## 与章节的差别只有一条：图鉴是**分区**的
 *
 * 章节是一堆平铺在内容目录里的 Markdown，类别写在每一篇自己的 frontmatter 里。
 * 图鉴多一层：内容目录（`.nide/config.yml` 的 `gallery`）底下**每个子目录是一个图鉴**
 * ——角色、地点、物品各一个 —— 而「这个图鉴有哪些字段」写在该目录自己的 `config.yml`
 * 里。所以「新建图鉴」建的是一个文件夹，不是一份文件。
 *
 * ```
 * gallery/                     <- 内容目录，由 .nide/config.yml 决定
 *   characters/                <- 一个图鉴（「角色」）
 *     config.yml               <- 字段表：名称、外貌……
 *     主角.yml                  <- 一个条目
 *     对手.yml
 *   locations/
 *     config.yml
 * ```
 *
 * 五条刻意的选择：
 *
 * 1. **图鉴 = 内容目录下的一层子目录**，不再嵌套。「哪个图鉴」由路径回答，条目文件
 *    因此不必再写一遍自己属于谁 —— 多一个 `gallery:` 键就多一个会与目录分叉的地方。
 * 2. **字段名就是显示名**，写进文件、也写进界面（`名称`、`外貌`）。分「键 + 显示名」
 *    两层要多一张映射表、多一层本地化，而图鉴是用户自己的东西，他改字段名顺手改掉
 *    显示名才是期望的行为。
 * 3. **条目是整份 YAML**（不是 Markdown 的 frontmatter）：`category` 说明它是图鉴条目，
 *    `data` 底下是各个字段。形状与章节 frontmatter **完全一致**，读取走同一份实现
 *    （见 ./frontmatter），只是章节那份包在 `---` 之间、正文在后面。
 * 4. **字段值只有单行 / 多行文本**。用户填的是「外貌」「备注」这类文字，不是结构化数据；
 *    手写的 `- ` 列表读成按行接起来的文本（见 cellText），不丢内容。
 * 5. **不认识的顶层键、嵌套结构一律判为读不出来**（见 parseGalleryConfig）：一个
 *    `config.yml` 是不是图鉴配置决定了界面给不给表单，而表单会按字段表**重写整份文件**
 *    —— 判得宽一点，就会把一份别人的配置文件改掉。
 *
 * 这一层是纯逻辑（不碰盘），主进程与渲染进程共用。
 */

/** 顶层：这个文件属于哪一类 */
export const GALLERY_CATEGORY_FIELD = 'category'

/** 顶层：字段块的键名 */
export const GALLERY_DATA_FIELD = 'data'

/** 图鉴这一类内容的类别值。表单只对写着它的 yml 出现 */
export const GALLERY_CATEGORY = 'gallery'

/** 图鉴的字段表文件名（在每个图鉴目录之内） */
export const GALLERY_CONFIG_FILE_NAME = 'config.yml'

/** 字段表里那个键 */
export const GALLERY_CONFIG_FIELDS_KEY = 'fields'

/** 条目文件的扩展名。图鉴条目必须是这两个之一 —— 表单会把整份文件按 YAML 重写 */
export const GALLERY_ENTRY_EXTENSIONS: readonly string[] = ['.yml', '.yaml']

/** 新建条目时补的扩展名（用户没写扩展名时） */
export const DEFAULT_GALLERY_ENTRY_EXTENSION = '.yml'

/**
 * 新建一个图鉴时的默认字段。
 *
 * 两个字段而不是空表：一个连「名称」都没有的图鉴里，条目列表连显示什么都答不出来
 * （见 galleryEntryLabel），而空白页不会告诉用户该加什么。
 */
export const DEFAULT_GALLERY_FIELDS: readonly string[] = ['名称', '描述']

/**
 * 默认角色图鉴的字段。
 *
 * 比通用默认多一项「外貌」，因为角色图鉴还有一个消费者：章节表单的「出场角色」
 * （见 .nide/config.yml 里图鉴那一段的 `characters`）。第一章还没写、先建几个角色是
 * 常态，所以字段要够用而不必先改配置。
 */
export const DEFAULT_CHARACTER_GALLERY_FIELDS: readonly string[] = ['名称', '外貌']

/** 新建项目时默认建出来的那个图鉴（角色）的目录名：默认配置里图鉴那一段记着它 */
export const DEFAULT_CHARACTER_GALLERY_NAME = DEFAULT_PROJECT_CONFIG.gallery.characters

/** 字段名长度上限。按字符算，与文件名的上限同一条理由（中日文按字节算会莫名很短） */
export const MAX_GALLERY_FIELD_LENGTH = 64

/** 一个图鉴最多几个字段。上限只为了让界面不至于长到没法用 */
export const MAX_GALLERY_FIELDS = 64

/** 字段表文件的注释头。写出来的第一行永远是它 */
export const GALLERY_CONFIG_HEADER =
  '# NIDE gallery configuration\n' +
  '# Fields of this gallery, in display order.\n' +
  '# The first field names an entry.\n'

// ============ 字段表（config.yml） ============

/** 一个图鉴的字段表 */
export interface GalleryConfig {
  /** 字段名，按显示顺序。空数组也是合法的（一个还没定义字段的图鉴） */
  fields: string[]
}

/**
 * 把一个字段名收敛成可用的写法，校验不过给出原因。
 *
 * 判据与 `./frontmatter` 的键规则同源：**含空白、冒号或 `#` 的名字读不回来**
 * （`名称 别名: x` 会被当成续行，`#` 开头的行整行是注释），所以这里就拒掉，
 * 而不是等用户存完、下次打开时发现字段没了。以 YAML 的其它写法开头的名字
 * （`-`、`&`、`*`、引号……）同理。
 */
export type InvalidGalleryFieldReason = 'empty' | 'illegal-character' | 'too-long' | 'duplicate'

export type GalleryFieldValidation =
  { ok: true; name: string } | { ok: false; reason: InvalidGalleryFieldReason }

/** 键里不能出现的字符：空白、冒号、`#`，以及控制字符 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_FIELD_CHARS = /[\s:#\u0000-\u001f\u007f]/

/** 以这些字符开头的键是 YAML 里别的写法（列表项、锚点、别名、引号……） */
const FIELD_STRUCTURAL_HEAD = /^[-&*!|>%@`{}[\]"']/

/** 这些字符在界面上看不出来，写进文件却会让 `键: 值` 变得没法解析 */
const INVISIBLE_FIELD_CHARS = /[\u200b-\u200f\u2028\u2029\ufeff]/

export function validateGalleryField(
  raw: string,
  existing: readonly string[] = []
): GalleryFieldValidation {
  const name = String(raw ?? '').trim()

  if (name.length === 0) return { ok: false, reason: 'empty' }
  if (ILLEGAL_FIELD_CHARS.test(name) || INVISIBLE_FIELD_CHARS.test(name)) {
    return { ok: false, reason: 'illegal-character' }
  }
  if (FIELD_STRUCTURAL_HEAD.test(name)) return { ok: false, reason: 'illegal-character' }
  if ([...name].length > MAX_GALLERY_FIELD_LENGTH) return { ok: false, reason: 'too-long' }
  if (existing.includes(name)) return { ok: false, reason: 'duplicate' }

  return { ok: true, name }
}

/**
 * 按字段表序列化 `config.yml`。
 *
 * 值一律加引号（与章节属性、`.nide/config.yml` 同一档）：字段名里可能有 `:` 之外的
 * 各种字符，而这一档 YAML 只认双引号标量。
 */
export function serializeGalleryConfig(config: GalleryConfig): string {
  const lines = config.fields.map((field) => `  - ${quoteYamlValue(field)}`)
  const body = lines.length === 0 ? '' : `${lines.join('\n')}\n`

  return `${GALLERY_CONFIG_HEADER}${GALLERY_CONFIG_FIELDS_KEY}:\n${body}`
}

/**
 * 读 `config.yml`；不是本模块认得的那份形状时给 null。
 *
 * 三条约束，都是为了**不让表单改错文件**：
 *
 * - `fields` 必须在（哪怕它是空的）。没有这个键的 yml 不是图鉴配置；
 * - 顶层**只许有这一个键**。多出别的键说明这份文件不只是字段表，而表单写回时只会写
 *   它认得的那一份 —— 判得宽一点就等于替用户删掉别的键；
 * - `fields` 底下必须是 `- ` 列表（或一个标量，见下）。嵌套映射读不出字段。
 *
 * `fields: 名称` 这种单个标量的写法也收：手写一份只有一个字段的配置是常事，而它读
 * 得出来之后就会被写成规范的那一种。
 */
export function parseGalleryConfig(text: string): GalleryConfig | null {
  if (typeof text !== 'string' || text.length === 0) return null

  const fields = parseDocumentFields(text)
  if (fields.size !== 1) return null

  const cell = fields.get(GALLERY_CONFIG_FIELDS_KEY)
  if (!cell) return null

  if (cell.items) return { fields: cell.items.map((item) => pickText(item)) }
  if (cell.children) return null

  if (cell.value !== undefined) {
    const single = pickText(cell.value).trim()
    return { fields: single.length === 0 ? [] : [single] }
  }

  // 只写了 `fields:`：一个还没有字段的图鉴，合法
  return { fields: [] }
}

/**
 * 这个文件名是不是图鉴的字段表。
 *
 * 只认名字，不认内容 —— 判据的另一半是 `parseGalleryConfig`（见 renderer 的
 * document-mode）：名字对、内容也读得出来，界面才给表单。
 */
export function isGalleryConfigFileName(filePathOrName: string): boolean {
  const name = baseNameOf(filePathOrName).toLowerCase()
  return name === GALLERY_CONFIG_FILE_NAME || name === 'config.yaml'
}

// ============ 条目（一个 .yml） ============

/** 一份图鉴条目读出来的样子 */
export interface GalleryEntryDocument {
  /** 顶层 `category` 的值；没有或读不出来时是空串 */
  category: string
  /** 字段名 -> 值。不含 `category` 与 `data` 这两个顶层键 */
  values: Record<string, string>
}

/** 条目的空白一份：没有内容，或者那一份不是宿主认得的形状 */
export function emptyGalleryEntry(): GalleryEntryDocument {
  return { category: '', values: {} }
}

/**
 * 从一份 yml 里读出一个图鉴条目。
 *
 * 取值与章节 frontmatter 同一条规则（见 ./chapters 的 readChapterMetadata）：先收
 * 顶层同名字段，再由 `data` 底下那一层覆盖。回落顶层是为了手写的文件 ——
 * `category: gallery` 之后直接平铺 `名称: 主角` 照样读得出来，元数据的位置不该成为
 * 用户写不下去的理由。
 *
 * 读不成标量的值**原样收下**（见 pickText）：一个没配对的引号不该让那个字段消失。
 * 嵌套结构（`data` 底下再分一层）不在表单里表示，因此不在这里出现。
 */
export function readGalleryEntry(text: string): GalleryEntryDocument {
  if (typeof text !== 'string' || text.length === 0) return emptyGalleryEntry()

  const fields = parseDocumentFields(text)
  const values: Record<string, string> = {}

  for (const [name, cell] of fields) {
    if (name === GALLERY_CATEGORY_FIELD || name === GALLERY_DATA_FIELD) continue

    const value = cellText(cell)
    if (value !== null) values[name] = value
  }

  const data = fields.get(GALLERY_DATA_FIELD)?.children
  if (data) {
    for (const [name, cell] of data) {
      const value = cellText(cell)
      if (value !== null) values[name] = value
    }
  }

  return { category: cellText(fields.get(GALLERY_CATEGORY_FIELD)) ?? '', values }
}

/**
 * 一个字段的文本。
 *
 * 三种情形：有值就取那个值；只有 `- ` 列表时按行接起来（手写的列表因此不会丢内容，
 * 只是变成一份多行文本）；两样都没有（嵌套结构）时给 null —— 调用方据此跳过它。
 */
function cellText(cell: FrontmatterCell | undefined): string | null {
  if (!cell) return null
  if (cell.value !== undefined) return pickText(cell.value)

  const items = cell.items
  if (!items || items.length === 0) return null

  return items.map((item) => pickText(item)).join('\n')
}

/**
 * 一个文本字段的值：能读成标量就按标量（会去掉外面的引号），读不出来时**原样收下**。
 *
 * 与章节属性用的是同一档解析（`parseYamlTextValue`）：同一份文件里的 `category` 与
 * `名称` 不会一个去引号、另一个不去。刻意不因为「读不成标量」就丢掉它 —— 用户写了
 * 一个没配对的引号时，他表达的意思仍然是一个字符串。
 */
function pickText(raw: string): string {
  return parseYamlTextValue(raw) ?? raw.trim()
}

/**
 * 一个条目该按哪几个字段来编辑：**配置里的字段按顺序在前，文件里多出来的跟在后面**。
 *
 * 多出来的那些（字段被改名或删掉之后的旧键）必须显示出来并且原样保留：它们是用户
 * 写在文件里的东西，表单没有资格替人删掉（写回时按这个顺序写，见 formatGalleryEntry）。
 */
export function galleryEntryFields(
  values: Readonly<Record<string, string>>,
  configFields: readonly string[]
): string[] {
  const result: string[] = []
  const seen = new Set<string>()

  for (const field of [...configFields, ...Object.keys(values)]) {
    const name = field.trim()
    // 空名字在配置里是「用户正在敲到一半」，在这里跳过：它不是一个能显示的字段
    if (name.length === 0 || seen.has(name)) continue

    seen.add(name)
    result.push(name)
  }

  return result
}

/**
 * 一个条目在列表里显示的名字：**第一个字段的值**，取不到时回落到文件名（去掉扩展名）。
 *
 * 「第一个字段当名字」是字段表的约定（见 GALLERY_CONFIG_HEADER）：图鉴的条目是角色、
 * 地点这类东西，而它们的名字就在第一个字段里。文件名是磁盘上的身份，名字取不到时
 * 它是最后一条能认出来的信息。
 */
export function galleryEntryLabel(
  values: Readonly<Record<string, string>>,
  fields: readonly string[],
  fileName: string
): string {
  const first = fields[0]
  const named = first ? (values[first] ?? '').trim() : ''
  if (named.length > 0) return named

  return fileNameWithoutExtension(fileName)
}

/** 文件名去掉扩展名（`.yml` / `.yaml`）。前导点开头的隐藏文件不算「有扩展名」 */
export function fileNameWithoutExtension(name: string): string {
  const base = baseNameOf(name)
  const extension = extensionOf(base)
  return extension.length === 0 ? base : base.slice(0, base.length - extension.length)
}

/**
 * 一个条目文件的规范名字：没有扩展名就补 `.yml`。
 *
 * 与「新建文件不补扩展名」那条约定**故意不同**，理由只有一个：条目**必须**是 yml
 * （`GALLERY_ENTRY_EXTENSIONS`），一个没有扩展名的条目在树里点不开、也没有表单 ——
 * 那是宿主让用户白敲一次名字。作为交换，对话框会把补出来的名字显示出来
 * （见 renderer 的 NamePromptDialog），所以磁盘上的名字与用户看见的那个仍然一致。
 */
export function galleryEntryFileName(raw: string): string {
  const name = String(raw ?? '').trim()
  const extension = extensionOf(name)
  if (GALLERY_ENTRY_EXTENSIONS.includes(extension)) return name

  return `${name}${DEFAULT_GALLERY_ENTRY_EXTENSION}`
}

/** 这个路径是不是一个图鉴条目文件（按扩展名判；是不是图鉴还要看内容） */
export function isGalleryEntryPath(filePath: string): boolean {
  return GALLERY_ENTRY_EXTENSIONS.includes(extensionOf(filePath))
}

/** 这个条目文档是不是宿主认得的图鉴条目（唯一判据是类别，与它在哪个目录里无关） */
export function isGalleryEntryDocument(entry: GalleryEntryDocument): boolean {
  return entry.category === GALLERY_CATEGORY
}

/**
 * 把一份字段值写成整份 yml。
 *
 * 三条约定，与章节属性那一侧严格对称：
 *
 * - **顶层只有 `category` 与 `data`**；
 * - **空值不写出来**。写一个空值进去等于替用户声明「这里就是空的」，而他根本没表达过
 *   这个意思；读的时候本来就分得清「没有这个键」与「值是空串」；
 * - **值一律加引号**（`quoteYamlValue` 顺带把换行转义成 `\n`），这样多行文本、冒号、
 *   引号都能原样读回来。
 *
 * 行尾固定 `\n`（不按平台给 `\r\n`）：这是要进版本库的文件，混用行尾是 diff 里最常见
 * 的噪声。
 */
export function formatGalleryEntry(
  values: Readonly<Record<string, string>>,
  order: readonly string[] = []
): string {
  const lines = [
    `${GALLERY_CATEGORY_FIELD}: ${quoteYamlValue(GALLERY_CATEGORY)}`,
    `${GALLERY_DATA_FIELD}:`
  ]

  for (const field of galleryEntryFields(values, order)) {
    const value = values[field] ?? ''
    if (value.length === 0) continue

    lines.push(`  ${field}: ${quoteYamlValue(value)}`)
  }

  return `${lines.join('\n')}\n`
}

/**
 * 新建一个条目时的初始内容：类别 + 空的字段块。
 *
 * 不预写各个字段的空值（理由与 formatGalleryEntry 同一条），所以建出来的条目在列表里
 * 显示的是文件名，直到用户填了第一个字段。内容与文件在**同一次调用**里落盘
 * （见 renderer 的 gallery-actions）：分两次写会在磁盘上留一个「建好了但还不是图鉴」
 * 的中间态，而那个中间态打不开表单。
 */
export function composeGalleryEntry(): string {
  return `${GALLERY_CATEGORY_FIELD}: ${quoteYamlValue(GALLERY_CATEGORY)}\n${GALLERY_DATA_FIELD}:\n`
}

// ============ 角色图鉴（.nide/config.yml 的 gallery.characters） ============

/**
 * 项目里「哪个图鉴是干什么用的」。
 *
 * 目前只有一个用途：**章节表单的出场角色从哪个图鉴里选**。它存在 `.nide` 里而不是
 * 写死在代码里，是因为图鉴的目录名是用户自己的命名（把 `characters` 改成 `人物` 是
 * 常事），而「角色图鉴是哪一个」这句话得有个地方记住。
 *
 * 值记在 `.nide/config.yml` 图鉴那一段的 `characters` 里（见 ./config）。这一层把它
 * 单独取出来，是因为图鉴的通道与界面只关心这一个字段。存的是**图鉴目录的名字**
 * （相对图鉴内容目录的一层），不是绝对路径：`.nide` 要跟项目一起进版本库，
 * 绝对路径换台机器就指向别处。
 */
export interface GalleryRegistry {
  /** 角色图鉴的目录名 */
  characters: string
}

/** 默认注册表：角色图鉴叫 `characters`（新建项目就会把它建出来） */
export const DEFAULT_GALLERY_REGISTRY: GalleryRegistry = {
  characters: DEFAULT_CHARACTER_GALLERY_NAME
}

/**
 * 把一个名字收敛成「图鉴目录名」：**只有一段**，不是绝对路径、不含 `..`。
 *
 * 判据与配置里那个 `characters` 是同一份实现（`normalizeDirectorySegment`）：图鉴是
 * 内容目录底下的一层，`卷一/角色` 那样的多段名字在这里没有意义，而放它过去就等于
 * 让配置能指向任意一层。
 */
export function normalizeGalleryName(raw: string): string | null {
  return normalizeDirectorySegment(raw)
}

// ============ IPC ============

/**
 * 图鉴的 IPC 通道名。
 *
 * 和其它通道一样集中在这里：拼错通道名没有编译错误，只会在运行时静默失效。
 */
export const PROJECT_GALLERY_CHANNELS = {
  /** 读图鉴目录下的所有图鉴（含各自的字段表与条目）与配置里的角色图鉴（invoke） */
  readGalleries: 'host:project-read-galleries',
  /** 新建一个图鉴：一个文件夹 + 它的 `config.yml`（invoke），参数见 GalleryCreateRequest */
  createGallery: 'host:project-create-gallery',
  /** 改注册表（图鉴目录名一定是主进程给的结论）（invoke），参数见 GalleryRegistryUpdateRequest */
  updateRegistry: 'host:project-update-gallery-registry'
} as const

/** 图鉴列表里的一个条目 */
export interface GalleryEntryFile {
  /** 绝对路径 */
  path: string
  /** 显示名（文件名） */
  name: string
  /** 列表里显示的名字：第一个字段的值，取不到时是文件名（见 galleryEntryLabel） */
  label: string
}

/** 图鉴列表里的一个图鉴 */
export interface GalleryFolder {
  /** 目录名。注册表里记的就是它 */
  name: string
  /** 绝对路径 */
  path: string
  /** 字段表文件的绝对路径。界面「编辑字段」打开的就是它 */
  configPath: string
  /**
   * 这个图鉴的字段。
   *
   * 读不出 `config.yml` 时给默认字段而不是空表（见主进程的 readProjectGalleries）：
   * 一个由别的工具建出来、或者 `config.yml` 被删掉的目录仍然是一个可用的图鉴 ——
   * 默认字段是「它没有自己的字段表」这个事实的表达，而空表会让每个条目都没法填。
   */
  fields: string[]
  /** 目录里的条目，按文件名排序（与文件树同一套排序） */
  entries: GalleryEntryFile[]
  /**
   * 这个图鉴目录读不出来时的原因。
   *
   * 只影响这一个图鉴的显示：别的图鉴读得出来就照常列出来 —— 一个目录没权限不该让
   * 整个图鉴面板变成一次失败。没有这个字段表示读到了。
   */
  error?: DirReadFailureReason
}

/**
 * 读图鉴列表的结果。失败原因与读目录共用一套（这一步本来就是读一个目录）。
 *
 * 注册表与图鉴列表放在同一个结果里：界面上它们总是一起用（「哪个图鉴是角色图鉴」
 * 只有在图鉴列表里才有意义），分成两条通道只会多一次往返与一个「注册表到了、列表
 * 还没到」的中间态。
 */
export type GalleryListResult =
  | { ok: true; path: string; registry: GalleryRegistry; galleries: GalleryFolder[] }
  | { ok: false; reason: DirReadFailureReason }

/** 主进程服务内部用的那一半：读图鉴目录（不含注册表，那属于 `.nide`） */
export type GalleryFoldersResult =
  | { ok: true; path: string; galleries: GalleryFolder[] }
  | { ok: false; reason: DirReadFailureReason }

/**
 * 「新建一个图鉴」的请求。
 *
 * `targetPath` 是**图鉴内容目录**（不是别的目录）：新图鉴建在它内部。它必须正是当前
 * 项目配置里那一个目录 —— 判据在主进程（见 ipc/project.ipc.ts），渲染进程声明不了
 * 「图鉴建到哪儿」。
 */
export interface GalleryCreateRequest {
  /** 图鉴内容目录的绝对路径 */
  targetPath: string
  /** 用户输入的图鉴名（单段目录名） */
  name: string
}

/** 失败原因与「新建条目」共用一套：对用户来说都是「这个文件夹没建成」 */
export type GalleryCreateResult =
  { ok: true; path: string; configPath: string } | { ok: false; reason: CreateEntryFailureReason }

/** 「改注册表」的请求。只收一个名字，它是不是一个真的图鉴由主进程判 */
export interface GalleryRegistryUpdateRequest {
  characters: string
}

/**
 * 改注册表的结果。
 *
 * `unknown-gallery` 单列：用户选中的那个名字在图鉴目录里找不到目录时，要说的是
 * 「这个图鉴不存在」，而不是笼统的「出错了」。
 */
export type GalleryRegistryUpdateResult =
  | { ok: true; registry: GalleryRegistry }
  | { ok: false; reason: 'invalid-name' | 'unknown-gallery' | 'unreadable' }
