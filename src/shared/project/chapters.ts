import { parseYamlTextValue } from '@shared/yaml'
import type { DirReadFailureReason } from './files'

/**
 * 章节 Markdown 的开头属性（frontmatter，也就是正文之前那一段 `---` 包起来的 YAML）。
 *
 * 它回答的是「这是第几章」。**刻意不从文件名推**：文件名是用户可以随时改的显示名
 * （`chapter_3.md` 改成 `决战前夜.md` 是常见需求），而章节号是正文的元数据 ——
 * 把身份放在文件名里，改一次名字就等于改一次章节号。所以两件事分开：名字管显示，
 * 属性管身份。
 *
 * 写法限定为最小那一档，形状是：
 *
 * ```
 * ---
 * chapter: 3
 * ---
 * ```
 *
 * 三条刻意的选择：
 *
 * 1. **只收 `chapter` 一个键**，别的键原样留着、不解释 —— 用户往 frontmatter 里写
 *    自己的字段（状态、视角、字数）是正常用法，宿主不认得的东西不该被它改写。
 * 2. **章节号写成至少三位的十进制**（`3` -> `003`）：文件按名字排序时 `chapter_010`
 *    会排在 `chapter_9` 前面，而三位补零让顺序在 999 章之内自然正确。读的时候
 *    几位都认（手写的 `chapter: 3` 也读得出来）。
 * 3. **没有 frontmatter 不算错**：那是「还没编号的章节」—— 文件树里手建的 `.md`
 *    就是这样，它照样能在章节列表里出现，只是拿不到号。
 *
 * 这一层是纯逻辑（不碰盘），主进程与渲染进程共用。
 */

/** 章节号在那个属性里的键名 */
export const CHAPTER_FIELD = 'chapter'

/**
 * frontmatter 的读取上限（字符数）。
 *
 * frontmatter 是正文之前的十几行，几 KiB 足够；上限存在的意义是**不必为一个属性
 * 读完整个文件** —— 一章稿子可能几百 KiB，而章节列表要扫一个目录里所有的章。
 */
export const FRONTMATTER_SCAN_LIMIT = 8 * 1024

/** 章节号补到几位。理由见文件头第 2 条 */
const CHAPTER_PAD_LENGTH = 3

/** `---` 那一行（允许尾部有空白） */
const FENCE = /^-{3,}\s*$/

/** `键: 值`。键只认字母、数字、下划线与连字符 —— frontmatter 里的键都是这个形状 */
const FIELD_LINE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/

export interface FrontmatterBlock {
  /** 整段 frontmatter（含两端的 `---` 行），用来无损替换 */
  raw: string
  /** 它之后的正文。原文的第一行在这个字符串的开头 */
  rest: string
}

/**
 * 把一段 Markdown 拆成「frontmatter」与「其余」。
 *
 * 只认文件**第一行**就是 `---` 的那种写法。首行不是围栏时返回 null：Markdown 里
 * `---` 也是分隔线（有些写法把标题写在下面），把正文里的一条横线当成 frontmatter
 * 的开头，会把后面半篇稿子吃掉。
 *
 * 找不到收尾围栏时同样返回 null（那说明这不是宿主写出来的文件），**不**把整个文件
 * 当成 frontmatter。
 */
export function splitFrontmatter(text: string): FrontmatterBlock | null {
  if (typeof text !== 'string' || text.length === 0) return null

  // 去掉 BOM：Windows 上的编辑器可能给它加上，而它会让首行比较失败
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text
  const lines = source.split(/\r?\n/)

  if (!FENCE.test(lines[0] ?? '')) return null

  for (let index = 1; index < lines.length; index++) {
    if (!FENCE.test(lines[index])) continue

    const head = lines.slice(0, index + 1).join('\n')
    const tail = lines.slice(index + 1).join('\n')

    return { raw: head, rest: tail }
  }

  return null
}

/**
 * 从一段 Markdown 里读章节号。
 *
 * 读不出来给 null，而且**区分不了**下面这几种情形（对调用方来说它们是同一件事：
 * 「这篇没有可用的章节号」）：没有 frontmatter、frontmatter 里没有 `chapter`、
 * 值不是正整数、值超出安全范围。
 */
export function parseChapterNumber(text: string): number | null {
  const block = splitFrontmatter(text)
  if (!block) return null

  const lines = block.raw.split(/\r?\n/)

  // 首尾两行是围栏，中间才是属性
  for (const line of lines.slice(1, -1)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue

    const match = FIELD_LINE.exec(trimmed)
    if (!match || match[1] !== CHAPTER_FIELD) continue

    const first = parseYamlTextValue(match[2])
    if (first !== null) return asChapterNumber(first)

    /**
     * 裸标量里的数字会被 parseYamlTextValue 挡掉（那是有意的：配置里的目录名写成
     * 数字没有意义）。章节号恰恰要的就是数字，所以这里对**这一行**再收一档，
     * 而且只收十进制整数。
     */
    return asChapterNumber(match[2].trim())
  }

  return null
}

/** 十进制正整数才算是章节号 */
function asChapterNumber(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null

  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** 章节号的规范写法：至少三位、补零。文件按名字排序时顺序才对 */
export function formatChapterNumber(value: number): string {
  return String(value).padStart(CHAPTER_PAD_LENGTH, '0')
}

/**
 * 造一章的初始内容：frontmatter 之后跟一个一级标题，正文留给用户。
 *
 * 写的是 `Chapter <n>` 这个**规范**标题：它就是这一章在列表里的显示名（见
 * parseChapterHeading），所以不能空着 —— 建完一片空白的话列表上只有文件名，而用户
 * 还得自己补一个标题才会发现列表跟着变了。
 *
 * 用英文而不是界面语言：这份内容会落进用户的稿子、进版本库，而界面语言随时可切 ——
 * 同一章的中文标题不该因为用户换了语言就换个样子。用户可以随手改成任何说法，那之后
 * 列表就跟着他走。
 *
 * 换行固定用 `\n`（不按平台给 `\r\n`）：这是文稿，它会进版本库、会被别的编辑器打开，
 * 而混用行尾是 diff 里最常见的噪声。
 */
export function composeChapterDocument(chapter: number): string {
  return `---\n${CHAPTER_FIELD}: ${formatChapterNumber(chapter)}\n---\n\n# ${defaultChapterHeading(chapter)}\n\n`
}

/** 一章的规范标题：`Chapter 1` */
export function defaultChapterHeading(chapter: number): string {
  return `Chapter ${chapter}`
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

/**
 * 已经用掉的章节号里的最大值；一个都没有时给 0。
 *
 * 「下一个号」因此是它 + 1。取最大值而不是数量：删掉第 2 章之后新建的第 3 章仍然
 * 是第 3 章，而按数量算会得到「新的一篇也是第 3 章」——两篇同号，而文件名不同，
 * 从文件名上看不出来。
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
 * 下一个可用的章节号。
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

  return asChapterNumber(match[1])
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
  /** frontmatter 里的章节号；没有或读不出来时为 null */
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
