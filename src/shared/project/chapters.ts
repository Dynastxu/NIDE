import { parseYamlTextValue, quoteYamlValue, unquoteYamlValue } from '#project/yaml'
import { parseFrontmatterFields, splitFrontmatter } from '#project/frontmatter'
import type { DirReadFailureReason } from '#project/files'

/**
 * 章节 Markdown 的开头属性（frontmatter，也就是正文之前那一段 `---` 包起来的 YAML）。
 *
 * 它回答的是「这是一篇什么内容、它是第几篇」。**刻意不从文件名推**：文件名是用户
 * 可以随时改的显示名（`chapter_3.md` 改成 `决战前夜.md` 是常见需求），而编号是正文的
 * 元数据 —— 把身份放在文件名里，改一次名字就等于改一次编号。所以两件事分开：名字管
 * 显示，属性管身份。
 *
 * 形状固定成「类别 + 数据块」两层，所有元数据都在 `data` 底下：
 *
 * ```
 * ---
 * category: chapter
 * data:
 *   index: "003"
 *   outline: 这一章要写什么
 *   characters:
 *     - 主角
 *     - 对手
 *   notes: 备注
 *   summary: 这一章的概述
 * ---
 * ```
 *
 * 四条刻意的选择：
 *
 * 1. **顶层只有 `category` 与 `data` 两个键。** 类别说明这篇内容归哪一类（将来图鉴、
 *    伏笔走同一套结构），数据块里的字段才随类别而变。分成两层而不是把 `index` 平铺在
 *    顶层，是因为顶层的键位有限：平铺之后每加一个字段都要占一个顶层键，而 `data`
 *    之下的键只属于它自己的类别，永远撞不上别人。
 * 2. **`index: 0` 是序章。** 所以「正整数或 0」是这个字段合法的全部取值，而
 *    `null`（没有这个键、读不出来、不是整数）才是「还没编号」。不把「没编号」也写成
 *    0，是为了让列表上的 `0`（序章）与 `—`（还没编号）分得开。
 * 3. **写出来的是双引号字符串**（`index: "003"`）。这一档 YAML 在 `#project/yaml`
 *    里刻意不把裸标量里的数字当字符串（配置里的目录名写成数字是没有意义的），而编号
 *    要的就是数字，所以这里由写的一侧负责加引号，读的一侧两种写法都收（`index: 3`
 *    是人手写的，照样读得出来）。
 * 4. **没有 frontmatter、或者类别不是 `chapter` 都不算错**：那是一篇普通的 Markdown
 *    （README、笔记、还没编号的稿子），它照样能在章节列表里出现，只是拿不到编号，
 *    编辑器那边也只是不给表单 —— 见 renderer 的章节元数据一层。
 *
 * 这一层是纯逻辑（不碰盘），主进程与渲染进程共用。
 *
 * 「开头那一块属性怎么读」（围栏、缩进、`data` 那一层）在 `./frontmatter`：图鉴条目
 * 读的是同一套形状，两个类别共用同一份实现。这一层只解释**章节认得的那几个键**。
 */

/** 顶层：这篇内容属于哪一类。取值见 CHAPTER_CATEGORY 等常量 */
export const CHAPTER_CATEGORY_FIELD = 'category'

/** 顶层：元数据块的键名 */
export const CHAPTER_DATA_FIELD = 'data'

/** 数据块里：编号 */
export const CHAPTER_INDEX_FIELD = 'index'

/** 数据块里：细纲 */
export const CHAPTER_OUTLINE_FIELD = 'outline'

/** 数据块里：出场角色 */
export const CHAPTER_CHARACTERS_FIELD = 'characters'

/** 数据块里：备注 */
export const CHAPTER_NOTES_FIELD = 'notes'

/** 数据块里：概述 */
export const CHAPTER_SUMMARY_FIELD = 'summary'

/**
 * 章节这一类内容的类别值。表单只对写着它的文件出现。
 *
 * 取值是英文的 `chapter`：它写进用户的文件、会被版本库与别的编辑器读到，而界面上
 * 显示的名字走 i18n（见 zh-CN 的 `host.project.panel.section.chapters`）。
 */
export const CHAPTER_CATEGORY = 'chapter'

/** 编号补到几位。理由见文件头第 3 条与 formatChapterNumber */
const CHAPTER_PAD_LENGTH = 3

/** 一节元数据：宿主认得的那几个字段；认不出来的字段读的时候就被丢掉了 */
export interface ChapterMetadata {
  /** 顶层 `category` 的值；没有或读不出来时是空串 */
  category: string
  /**
   * 编号。`0` 是序章（见文件头第 2 条），`null` 是「还没编号」。
   *
   * 与 `ChapterFile.chapter` 的区别只在语境：那边是列表里的一个结论，这里是编辑器
   * 表单要编辑的一个值。
   */
  index: number | null
  /** 细纲。没有这个键时是空串 */
  outline: string
  /** 出场角色。没有这个键时是空数组；同一个角色写两遍只算一次（见 uniqueTexts） */
  characters: string[]
  /** 备注 */
  notes: string
  /** 概述 */
  summary: string
}

/** 节元数据的空白一份：没有 frontmatter，或者那一份不是宿主认得的形状 */
export function emptyChapterMetadata(): ChapterMetadata {
  return { category: '', index: null, outline: '', characters: [], notes: '', summary: '' }
}

/**
 * 从一段 Markdown 里读一节元数据。
 *
 * 三层取值，缺一层就回落到下一层：数据块里的字段 -> 顶层同名字段 -> 空值。回落顶层
 * 是为了手写的文件：`outline: 这一章要写什么` 这种写法没有 `data:` 也一样读得出来 ——
 * 元数据的位置不该成为用户写不下去的理由。
 */
export function readChapterMetadata(text: string): ChapterMetadata {
  if (typeof text !== 'string' || text.length === 0) return emptyChapterMetadata()

  const fields = parseFrontmatterFields(splitFrontmatter(text))
  const data = fields.get(CHAPTER_DATA_FIELD)?.children

  const pick = (name: string): string => pickText(data?.get(name)?.value ?? fields.get(name)?.value)
  const items = data?.get(CHAPTER_CHARACTERS_FIELD)?.items

  return {
    category: pick(CHAPTER_CATEGORY_FIELD),
    index: parseChapterIndex(
      data?.get(CHAPTER_INDEX_FIELD)?.value ?? fields.get(CHAPTER_INDEX_FIELD)?.value
    ),
    outline: pick(CHAPTER_OUTLINE_FIELD),
    characters: uniqueTexts(items ?? []),
    notes: pick(CHAPTER_NOTES_FIELD),
    summary: pick(CHAPTER_SUMMARY_FIELD)
  }
}

/**
 * 一个文本字段的值：能读成标量就按标量（会去掉外面的引号），读不出来时**原样收下**。
 *
 * 刻意不因为「读不成标量」就丢掉它：这一层的字段是纯文本，用户写 `outline: 123` 或
 * 一个没配对的引号时，他表达的意思仍然是一个字符串，把它清空比留一段原文更糟。
 * 写出去的那一份永远能读回来（`formatChapterMetadata` 一定会加引号），所以这条回落
 * 只对手写的文件有意义。
 *
 * 与角色列表用的是同一档解析（`parseYamlTextValue`）—— 同一份文件里的
 * `category: "chapter"` 与 `- 主角` 因此不会一个去引号、另一个不去。
 */
function pickText(raw: string | undefined): string {
  if (raw === undefined) return ''

  return parseYamlTextValue(raw) ?? raw.trim()
}

/**
 * 一个编号字符串是不是合法的编号：十进制整数，`0` 也算（序章）。
 *
 * 读得出来的三种写法：宿主写出去的双引号字符串（`"003"`）、手写的裸数字（`3`）、
 * 以及补零的裸数字（`007`）。负数、小数、空、非数字、带引号的非数字都给 null。
 */
function parseChapterIndex(raw: string | undefined): number | null {
  if (raw === undefined) return null

  const unquoted = unquoteYamlValue(raw.trim()) ?? raw
  const trimmed = unquoted.trim()
  if (!/^\d+$/.test(trimmed)) return null

  const value = Number(trimmed)
  return Number.isSafeInteger(value) ? value : null
}

/** 角色列表：去掉读不出来的行、去掉重复，保留原来的先后 */
function uniqueTexts(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    // 与文本字段同一条回落：读不成标量时按原文收下（角色名就是一段文本）
    const text = (parseYamlTextValue(value) ?? value.trim()).trim()
    if (text.length === 0) continue
    if (seen.has(text)) continue

    seen.add(text)
    result.push(text)
  }

  return result
}

/**
 * 要从一段 Markdown 里读编号；读不出来给 null。
 *
 * 判据集中在 readChapterMetadata 里（同一条规则只写一处），这里只是它的一层薄封装：
 * 主进程读章节列表时只关心编号，而它读的是每篇稿子的开头 —— 目录里有多少篇就要读
 * 多少次，没必要为编号把细纲、备注这一串也解释一遍。
 */
export function parseChapterNumber(text: string): number | null {
  const block = splitFrontmatter(text)
  if (!block) return null

  const data = parseFrontmatterFields(block).get(CHAPTER_DATA_FIELD)?.children

  return parseChapterIndex(data?.get(CHAPTER_INDEX_FIELD)?.value)
}

// ============ 写回 ============

/**
 * 一节元数据 -> frontmatter 里的那几行（不含两端的 `---`）。
 *
 * 两条约定：
 *
 * - **没值的字段不写出来**（`index` 为 null 时没有 `index:` 行，角色为空时没有
 *   `characters:` 块）。写一个空值进去等于替用户声明「这里就是空的」，而他根本没
 *   表达过这个意思；反过来，读的时候本来就分得清「没有这个键」与「值是空串」。
 * - **值一律加引号**（`quoteYamlValue`），只有空串写成 `""`。理由见文件头第 3 条：
 *   这一档 YAML 把裸数字当成别的类型，而编号恰恰是数字。
 */
export function formatChapterMetadata(metadata: ChapterMetadata): string[] {
  const lines: string[] = [`${CHAPTER_CATEGORY_FIELD}: ${quoteYamlValue(metadata.category)}`]

  const data: string[] = []

  if (metadata.index !== null) {
    data.push(`  ${CHAPTER_INDEX_FIELD}: ${quoteYamlValue(formatChapterNumber(metadata.index))}`)
  }
  if (metadata.outline.length > 0) {
    data.push(`  ${CHAPTER_OUTLINE_FIELD}: ${quoteYamlValue(metadata.outline)}`)
  }
  if (metadata.characters.length > 0) {
    data.push(`  ${CHAPTER_CHARACTERS_FIELD}:`)
    for (const name of metadata.characters) data.push(`    - ${quoteYamlValue(name)}`)
  }
  if (metadata.notes.length > 0) {
    data.push(`  ${CHAPTER_NOTES_FIELD}: ${quoteYamlValue(metadata.notes)}`)
  }
  if (metadata.summary.length > 0) {
    data.push(`  ${CHAPTER_SUMMARY_FIELD}: ${quoteYamlValue(metadata.summary)}`)
  }

  // 数据块一行都没有时只留 `data:`：那一行说的是「这篇有元数据块，只是还空着」
  lines.push(`${CHAPTER_DATA_FIELD}:`)
  lines.push(...data)

  return lines
}

/**
 * 把一节元数据写回一段 Markdown，**正文原样不动**。
 *
 * 三条约束：
 *
 * 1. **只换 frontmatter 那一块**，正文连行尾都不碰 —— 用户在编辑器里的排版、空行、
 *    CRLF 都不该因为改了一个编号而变化。
 * 2. **原来没有 frontmatter 时补一块出来**，并把正文推到它下面（中间留一个空行，
 *    这是 Markdown 里 frontmatter 与正文之间的常规写法）。
 * 3. **写出来的行尾固定用 `\n`**：这是文稿，它会进版本库、会被别的编辑器打开，而混用
 *    行尾是 diff 里最常见的噪声（与 composeChapterDocument 同一条约定）。
 */
export function writeChapterMetadata(text: string, metadata: ChapterMetadata): string {
  const block = splitFrontmatter(text)
  const lines = formatChapterMetadata(metadata)
  const front = `---\n${lines.join('\n')}\n---\n`

  if (!block) {
    const body = text.replace(/^\uFEFF/, '')
    return body.length === 0 ? front : `${front}\n${body}`
  }

  /**
   * 正文从围栏之后开始，而 splitFrontmatter 给的是「余下的一切」—— 它可能以空行
   * 开头（`---\n\n正文`），也可能直接就是正文。原样接回去，只在完全没有分隔时补一个
   * 空行，免得正文贴到 `---` 上。
   */
  const rest = block.rest

  return rest.length === 0 || rest.startsWith('\n') ? `${front}${rest}` : `${front}\n${rest}`
}

// ============ 造一章 ============

/** 章节号的规范写法：至少三位、补零。文件按名字排序时顺序才对 */
export function formatChapterNumber(value: number): string {
  return String(value).padStart(CHAPTER_PAD_LENGTH, '0')
}

/**
 * 造一章的初始内容：frontmatter 之后跟一个一级标题，正文留给用户。
 *
 * 写的是 `Chapter <n>` 这个**规范**标题：它是这一章的初始正文，用户可以随手改成任何
 * 说法。编号本身在 frontmatter 里（见文件头），标题只影响正文。
 *
 * 换行固定用 `\n`（不按平台给 `\r\n`）：这是文稿，它会进版本库、会被别的编辑器打开，
 * 而混用行尾是 diff 里最常见的噪声。
 */
export function composeChapterDocument(chapter: number): string {
  const metadata: ChapterMetadata = {
    category: CHAPTER_CATEGORY,
    index: chapter,
    outline: '',
    characters: [],
    notes: '',
    summary: ''
  }

  return `${writeChapterMetadata('', metadata)}\n# ${defaultChapterHeading(chapter)}\n\n`
}

/** 一章的规范标题：`Chapter 1` */
export function defaultChapterHeading(chapter: number): string {
  return `Chapter ${chapter}`
}

/**
 * 一篇 Markdown 的**正文**：frontmatter 之后的那一部分。
 *
 * 与 `parseChapterHeading` 取正文用的是同一条规则（有 frontmatter 就从它之后开始，没有
 * 就整篇），这样「元数据在哪结束」只有一处定义。两处细节值得写下来：
 *
 * 1. **分隔用的那个空行被吃掉**（`---\n\n正文` 给的是 `正文`）。它是排版约定而不是
 *    内容，留着只会让预览的首行凭空多出一行空白。
 * 2. 没有 frontmatter 时整篇都算正文，BOM 顺手去掉。
 *
 * 预览用它来**不显示元数据**：frontmatter 是给宿主读的，不是给读者看的（见 renderer
 * 的 MarkdownPreview）。
 */
export function chapterBodyOf(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return ''

  const block = splitFrontmatter(text)
  if (!block) return text.replace(/^\uFEFF/, '')

  return block.rest.replace(/\r?\n/, '')
}

/**
 * 把一段**正文**写回一篇 Markdown，frontmatter 原样不动。
 *
 * 与 `writeChapterMetadata` 是一对：那边只换开头那一块、正文一个字都不碰；这边只换
 * 正文、开头那一块一个字都不碰。表单模式里的正文编辑器用的就是它 —— 编辑器里只有
 * 正文（frontmatter 由表单字段管），而文件里仍然是「元数据 + 正文」一整篇。
 *
 * 三条约束：
 *
 * 1. **围栏与正文之间固定留一个空行。** 这一条是为了让读回来的正文与写进去的那份
 *    逐字相同：`chapterBodyOf` 摘正文时吃掉的是紧跟围栏的那一个换行，所以只有
 *    「围栏 + 空行 + 正文」这种写法能满足 `chapterBodyOf(writeChapterBody(text, body))
 *    === body`（对任何 body 都成立，包括空正文与以换行开头的正文）。
 * 2. **frontmatter 那一段原样搬回去**（`splitFrontmatter` 给的 `raw`），不在这里整理
 *    用户的元数据：那是表单字段与 `writeChapterMetadata` 的事。它的行尾跟着那一份
 *    的约定走 `\n`（与 `writeChapterMetadata` 写出来的 frontmatter 同一条约定）。
 * 3. **没有 frontmatter 时整篇就是正文**：写回来也就是正文本身 —— 与 `chapterBodyOf`
 *    的另一半严格对称（那边把整篇当正文读，这边把整篇当正文写）。
 */
export function writeChapterBody(text: string, body: string): string {
  const block = splitFrontmatter(text)
  if (!block) return body

  return `${block.raw}\n\n${body}`
}

/**
 * 从一段 Markdown 里读**一级标题**（`# …`）。
 *
 * 列表里「这一章叫什么」用的是它：文件名是磁盘上的身份，而一级标题是作者给这一章
 * 起的标题（「决战前夜」），后者才是他写给人看的那个。读不出来给 null —— 界面那时
 * 回落到文件名。
 *
 * 三条刻意的限定：
 *
 * - **只认 ATX 写法**（`# 标题`）。Setext 写法（下面画一排 `=`）在文稿里很少见，而认
 *   它要往下多看一行，还可能被正文里的分隔线误导。
 * - **只认一级标题**：`##` 是分节，拿它当章节标题会把「第一节」印到章节列表上。
 * - **跳过代码围栏里的内容**：稿子里贴一段代码是常事，而那种块里的 `# 注释` 是注释。
 */
export function parseChapterHeading(text: string): string | null {
  // 正文从 frontmatter 之后开始；没有 frontmatter 时整篇都算正文
  const rest = splitFrontmatter(text)?.rest ?? text

  let fence: string | null = null

  for (const rawLine of rest.split(/\r?\n/)) {
    const line = rawLine.trim()

    if (fence !== null) {
      if (line.startsWith(fence)) fence = null
      continue
    }
    if (/^(```|~~~)/.test(line)) {
      fence = line.slice(0, 3)
      continue
    }

    const match = /^#\s+(.*)$/.exec(line)
    if (!match) continue

    const title = match[1].trim()
    return title.length > 0 ? title : null
  }

  return null
}

// ============ 编号的计算 ============

/**
 * 已经用掉的编号里的最大值；一个都没有时给 0。
 *
 * 「下一个号」因此是它 + 1。取最大值而不是数量：删掉第 2 章之后新建的第 3 章仍然
 * 是第 3 章，而按数量算会得到「新的一篇也是第 3 章」——两篇同号，而文件名不同，
 * 从文件名上看不出来。
 *
 * 序章（0）不参与：它的 0 比「还没有任何一章」的 0 更大没有意义，把它算成最大值
 * 只会让第一个正式章节拿到 1（那正是对的）。所以判据写成 `value > highest`，
 * 0 与 0 相等时不会抬高结果。
 */
export function highestChapterNumber(used: readonly (number | null)[]): number {
  let highest = 0

  for (const value of used) {
    if (value === null || !Number.isSafeInteger(value)) continue
    if (value > highest) highest = value
  }

  return highest
}

/**
 * 下一个可用的编号。
 *
 * 除了已用的最大值，还要躲开**目录里已经存在的文件名**：用户可能删了某一章的
 * frontmatter（于是它对扫描不可见），但 `chapter_003.md` 这个文件还在 —— 直接用
 * 最大值 + 1 会撞上它，而新建是「绝不覆盖」的，结果是一次莫名其妙的失败。
 */
export function nextChapterNumber(
  used: readonly (number | null)[],
  takenFileNumbers: readonly number[] = []
): number {
  let next = highestChapterNumber(used) + 1

  const taken = new Set(takenFileNumbers.filter((value) => Number.isSafeInteger(value)))
  while (taken.has(next)) next += 1

  return next
}

/**
 * 从 `chapter_<数字>.md` 这样的文件名里取数字，取不出来给 null。
 *
 * 只管**默认文件名**这一档：用户自己起的名字（`决战前夜.md`）不参与「这个号被占了
 * 吗」的判断，它是不是某一章由 frontmatter 说了算。
 */
export function chapterNumberFromFileName(name: string): number | null {
  const match = /^chapter_(\d+)\.md$/i.exec(name.trim())
  if (!match) return null

  return parseChapterIndex(match[1])
}

/** 默认文件名：`chapter_1.md`。号补到三位以上，排序才不会乱 */
export function defaultChapterFileName(chapter: number): string {
  return `chapter_${chapter}.md`
}

// ============ 章节列表（IPC 的载荷形状） ============

/**
 * 内容目录里的一个章节文件。
 *
 * `chapter` 是**从文件里读出来的**（frontmatter），不是从名字推的 —— 见文件头。
 * 读不出编号时是 null：那是一个「还没编号的章节」，不是错误。
 */
export interface ChapterFile {
  /** 绝对路径 */
  path: string
  /** 显示名（文件名） */
  name: string
  /** frontmatter 里的编号；没有或读不出来时为 null。0 是序章 */
  chapter: number | null
  /**
   * 正文里的一级标题；没有时为 null。
   *
   * 列表优先显示它（见 renderer 的 ProjectsPanel）：文件名是磁盘上的身份，而标题是
   * 作者给这一章起的名字。读不出来就回落到文件名。
   */
  heading: string | null
}

/** 读章节列表的结果。失败原因与读目录共用一套（这一步本来就是读一个目录） */
export type ChapterListResult =
  { ok: true; path: string; chapters: ChapterFile[] } | { ok: false; reason: DirReadFailureReason }

/**
 * 这个文件名像不像宿主建的章节文件（`chapter_<数字>.md`，见 defaultChapterFileName）。
 *
 * 用途只有一个：算下一个章节号时**躲开已经被占用的文件名**（用户可能删掉了某一章的
 * frontmatter，而文件还在）。用户自己起的名字不参与这个判断 —— 它是不是某一章由
 * frontmatter 说了算。
 */
export function isDefaultChapterFileName(name: string): boolean {
  return chapterNumberFromFileName(name) !== null
}

/** 只留章节列表里那些「像章节文件」的条目，供躲避重名用 */
export function takenChapterFileNumbers(files: readonly ChapterFile[]): number[] {
  const numbers: number[] = []

  for (const file of files) {
    const value = chapterNumberFromFileName(file.name)
    if (value !== null) numbers.push(value)
  }

  return numbers
}

/** 章节列表里已经用掉的编号（含读不出来的那些位置上的 null） */
export function usedChapterNumbers(files: readonly ChapterFile[]): (number | null)[] {
  return files.map((file) => file.chapter)
}

/**
 * 这一篇是不是宿主认得的「章节」。
 *
 * 唯一判据是 frontmatter 里的类别，**不看它在哪个目录里**：同一个目录下放着一篇
 * README 是常态，而表单要不要出现取决于这篇内容自己声明的是什么（见文件头第 1 条）。
 */
export function isChapterDocument(metadata: ChapterMetadata): boolean {
  return metadata.category === CHAPTER_CATEGORY
}
