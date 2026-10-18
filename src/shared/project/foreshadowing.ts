import { parseYamlTextValue, quoteYamlValue } from '@shared/yaml'
import { parseDocumentFields } from './frontmatter'
import { baseNameOf, extensionOf } from './files'
import type { DirReadFailureReason } from './files'

/**
 * 伏笔 YAML 的契约：**整份文件就是这一条伏笔的属性**，没有正文。
 *
 * 形状与图鉴条目完全一致（见 ./gallery），与章节的 frontmatter 相比少了两端的
 * `---` 围栏：章节是「属性 + 正文」的 Markdown，而伏笔只有属性，所以整份文件就是
 * 那一块 YAML。
 *
 * ```yaml
 * category: "foreshadowing"
 * data:
 *   name: "主角的身世"
 *   startChapter: "003"
 *   endChapter: "012"
 *   description: "第一章埋下的那枚玉佩，到第十二章才解释清楚。"
 * ```
 *
 * 四条刻意的选择：
 *
 * 1. **字段固定为四个**：名称、起始章节、结束章节、描述。因此这里不需要图鉴那样的
 *    字段表，表单也不按配置生成字段，而是直接给出这四个输入项。
 * 2. **起始与结束章节是字符串，不是数字。** 它们是对章节的引用，不是章节自己的编号：
 *    作者可能写 `003`、`第三章`、`序章`，也可能写一个还没编号的章节标题。收成
 *    数字会把 `第三章` 这种写法直接判为无效，而这个字段存在的意义是让人读懂，
 *    不是参与计算。
 * 3. **字段不写出来就等于空。** 写回时只写有值的字段（与章节属性、图鉴条目同一条
 *    约定）：写一个空值进去等于替用户声明「这里就是空的」，而他并没有表达过。
 * 4. **只认 `.yml` / `.yaml`。** 表单会把整份文件按 YAML 重写，所以一个写着
 *    `category: foreshadowing` 的 `.md` 不能当伏笔 —— 那样保存一次就等于在
 *    一份 Markdown 里塞进一段 YAML。
 *
 * 没有 `category`、或者类别不是 `foreshadowing` 都不算错：那是一个普通的 yml
 * （别的工具的配置、还没整理的设想），它仍然出现在伏笔列表里，只是拿不到名称，
 * 编辑器那边也不给表单 —— 与章节、图鉴同一条边界。
 *
 * 这一层是纯逻辑（不碰盘），主进程与渲染进程共用。
 */

/** 顶层：这篇内容属于哪一类 */
export const FORESHADOWING_CATEGORY_FIELD = 'category'

/** 顶层：元数据块的键名 */
export const FORESHADOWING_DATA_FIELD = 'data'

/** 数据块里：名称 */
export const FORESHADOWING_NAME_FIELD = 'name'

/** 数据块里：起始章节 */
export const FORESHADOWING_START_FIELD = 'startChapter'

/** 数据块里：结束章节 */
export const FORESHADOWING_END_FIELD = 'endChapter'

/** 数据块里：描述 */
export const FORESHADOWING_DESCRIPTION_FIELD = 'description'

/**
 * 伏笔这一类内容的类别值。表单只对写着它的 yml 出现。
 *
 * 取值是英文的 `foreshadowing`：它写进用户的文件、会被版本库与别的编辑器读到，而
 * 界面上显示的名字走 i18n（见 zh-CN 的 `host.project.panel.section.foreshadowing`）。
 */
export const FORESHADOWING_CATEGORY = 'foreshadowing'

/**
 * 伏笔文件的扩展名。与图鉴条目一样，表单会把整份文件按 YAML 重写，所以只认这两种；
 * 一个没有扩展名的伏笔在树里点得动、只是拿不到表单。
 */
export const FORESHADOWING_FILE_EXTENSIONS: readonly string[] = ['.yml', '.yaml']

/** 新建伏笔时补的扩展名（用户没写扩展名时） */
export const DEFAULT_FORESHADOWING_EXTENSION = '.yml'

/** 一条伏笔的元数据：宿主认得的四个字段；认不出来的字段读的时候就被丢掉了 */
export interface ForeshadowingMetadata {
  /** 顶层 `category` 的值；没有或读不出来时是空串 */
  category: string
  /** 名称。没有这个键时是空串 */
  name: string
  /** 起始章节。没有这个键时是空串 */
  startChapter: string
  /** 结束章节。没有这个键时是空串 */
  endChapter: string
  /** 描述。没有这个键时是空串 */
  description: string
}

/** 伏笔元数据的空白一份：没有内容，或者那一份不是宿主认得的形状 */
export function emptyForeshadowingMetadata(): ForeshadowingMetadata {
  return { category: '', name: '', startChapter: '', endChapter: '', description: '' }
}

/**
 * 从一份 yml 里读一条伏笔。
 *
 * 取值与图鉴条目、章节 frontmatter 同一条规则：先收顶层同名字段，再由 `data` 底下
 * 那一层覆盖。回落顶层是为了手写的文件 —— `category: foreshadowing` 之后直接平铺
 * `name: 主角的身世` 照样读得出来，元数据的位置不该成为用户写不下去的理由。
 *
 * 读不成标量的值**原样收下**（见 pickText）：一个没配对的引号不该让那个字段消失。
 */
export function readForeshadowingEntry(text: string): ForeshadowingMetadata {
  if (typeof text !== 'string' || text.length === 0) return emptyForeshadowingMetadata()

  const fields = parseDocumentFields(text)
  const data = fields.get(FORESHADOWING_DATA_FIELD)?.children

  const pick = (name: string): string => pickText(data?.get(name)?.value ?? fields.get(name)?.value)

  return {
    category: pick(FORESHADOWING_CATEGORY_FIELD),
    name: pick(FORESHADOWING_NAME_FIELD),
    startChapter: pick(FORESHADOWING_START_FIELD),
    endChapter: pick(FORESHADOWING_END_FIELD),
    description: pick(FORESHADOWING_DESCRIPTION_FIELD)
  }
}

/**
 * 一个文本字段的值：能读成标量就按标量（会去掉外面的引号），读不出来时**原样收下**。
 *
 * 与章节属性、图鉴条目用的是同一档解析（`parseYamlTextValue`）：用户写了一个没配对
 * 的引号时，他表达的意思仍然是一个字符串，把它清空比留一段原文更糟。写出去的那一份
 * 永远能读回来（`formatForeshadowingEntry` 一定会加引号），所以这条回落只对
 * 手写的文件有意义。
 */
function pickText(raw: string | undefined): string {
  if (raw === undefined) return ''

  return parseYamlTextValue(raw) ?? raw.trim()
}

// ============ 写回 ============

/**
 * 一条伏笔 -> 整份 yml。
 *
 * 三条约定与章节属性、图鉴条目严格一致：
 *
 * - **顶层只有 `category` 与 `data`**；
 * - **没值的字段不写出来**（名称为空时没有 `name:` 行，描述为空时没有
 *   `description:` 行）。读的时候本来就分得清「没有这个键」与「值是空串」；
 * - **值一律加引号**（`quoteYamlValue`）。这一档 YAML 把裸数字、裸布尔当成别的类型，
 *   而这里四个字段都是文本；引号同时让换行、冒号与引号都能原样读回来。
 *
 * 行尾固定 `\n`：这是要进版本库的文件，混用行尾是 diff 里最常见的噪声。
 */
export function formatForeshadowingEntry(metadata: ForeshadowingMetadata): string {
  const lines = [
    `${FORESHADOWING_CATEGORY_FIELD}: ${quoteYamlValue(metadata.category)}`,
    `${FORESHADOWING_DATA_FIELD}:`
  ]

  if (metadata.name.length > 0) {
    lines.push(`  ${FORESHADOWING_NAME_FIELD}: ${quoteYamlValue(metadata.name)}`)
  }
  if (metadata.startChapter.length > 0) {
    lines.push(`  ${FORESHADOWING_START_FIELD}: ${quoteYamlValue(metadata.startChapter)}`)
  }
  if (metadata.endChapter.length > 0) {
    lines.push(`  ${FORESHADOWING_END_FIELD}: ${quoteYamlValue(metadata.endChapter)}`)
  }
  if (metadata.description.length > 0) {
    lines.push(`  ${FORESHADOWING_DESCRIPTION_FIELD}: ${quoteYamlValue(metadata.description)}`)
  }

  return `${lines.join('\n')}\n`
}

/**
 * 新建一条伏笔时的初始内容：类别与一个空的数据块。
 *
 * 不预写四个字段的空值（理由与 formatForeshadowingEntry 同一条），所以建出来的伏笔
 * 在列表里显示的是文件名，直到用户填了名称。内容与文件在**同一次调用**里落盘
 * （见 renderer 的 foreshadowing-actions）：分两次写会在磁盘上留一个「建好了但还不是
 * 伏笔」的中间态，而那个中间态打不开表单。
 */
export function composeForeshadowingEntry(): string {
  return formatForeshadowingEntry({
    ...emptyForeshadowingMetadata(),
    category: FORESHADOWING_CATEGORY
  })
}

/**
 * 这一篇是不是宿主认得的「伏笔」。
 *
 * 唯一判据是 `category`，**不看它在哪个目录里**：同一个目录下放一份别的 yml 是常态，
 * 而表单要不要出现取决于这份内容自己声明的是什么。
 */
export function isForeshadowingDocument(metadata: ForeshadowingMetadata): boolean {
  return metadata.category === FORESHADOWING_CATEGORY
}

/** 这个路径是不是伏笔文件（按扩展名判；是不是伏笔还要看内容） */
export function isForeshadowingPath(filePath: string): boolean {
  return FORESHADOWING_FILE_EXTENSIONS.includes(extensionOf(filePath))
}

// ============ 伏笔列表（IPC 的载荷形状） ============

/**
 * 伏笔目录里的一个文件。
 *
 * 四个字段都是**从文件里读出来的**，不是从文件名推的：文件名是用户可以随时改的
 * 显示名，而名称、起止章节与描述是这一条伏笔的元数据。
 */
export interface ForeshadowingFile {
  /** 绝对路径 */
  path: string
  /** 显示名（文件名） */
  name: string
  /** 列表里显示的名称：名称为空时回落到文件名（去掉扩展名） */
  label: string
  /** 起始章节；没有这个键时是空串 */
  startChapter: string
  /** 结束章节；没有这个键时是空串 */
  endChapter: string
  /** 描述；没有这个键时是空串 */
  description: string
}

/** 读伏笔列表的结果。失败原因与读目录共用一套（这一步本来就是读一个目录） */
export type ForeshadowingListResult =
  | { ok: true; path: string; foreshadowing: ForeshadowingFile[] }
  | { ok: false; reason: DirReadFailureReason }

/**
 * 一条伏笔在列表里显示的名字：**名称字段的值**，取不到时回落到文件名（去掉扩展名）。
 *
 * 名称是作者给这条伏笔起的名字，文件名是磁盘上的身份；前者才是他写给人看的那个。
 */
export function foreshadowingEntryLabel(
  metadata: Pick<ForeshadowingMetadata, 'name'>,
  fileName: string
): string {
  const named = metadata.name.trim()
  if (named.length > 0) return named

  const base = baseNameOf(fileName)
  const extension = extensionOf(base)
  return extension.length === 0 ? base : base.slice(0, base.length - extension.length)
}
