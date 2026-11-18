/**
 * 「文件开头那一块属性」的读取：章节 Markdown 的 frontmatter（`---` 包起来的那一段），
 * 以及图鉴条目（整份文件就是这一块）。
 *
 * 从 `./chapters` 里抽出来，是因为图鉴要的是**同一件事**：顶层一组 `键: 值`、其中
 * `data:` 一段是「这个类别的字段」。两个类别各写一份的话，那段缩进归属的判断
 * （见 `readBlockTail`，它是这一层唯一容易写错的地方，注释里记着两种真实出现过的错法）
 * 迟早会分叉，而分叉的表现是「章节读得出、图鉴读不出」这类只在运行时才看得见的事。
 *
 * 这一层是纯逻辑（不碰盘），主进程与渲染进程共用。
 *
 * ## 类别由调用方判，这一层只读形状
 *
 * 谁属于哪一类写在文件的 `category` 键里（章节是 `chapter`，图鉴是 `gallery`），
 * 但这一层**不解释**那个值：它只把顶层字段与 `data` 那一层交出去，由各自的模块
 * （`./chapters` / `./gallery`）决定认不认。多一个类别时这里不必改。
 */

/**
 * frontmatter 的读取上限（字符数）。
 *
 * frontmatter 是正文之前的十几行，几 KiB 足够；上限存在的意义是**不必为一个属性
 * 读完整个文件** —— 一章稿子可能几百 KiB，而章节列表要扫一个目录里所有的章。
 *
 * 元数据比只有编号那一版多出细纲、备注、概述三项，所以这个上限也跟着放宽了一档：
 * 一份写满的 frontmatter 不该在读到一半时被截断，那会让列表把一个有编号的章节
 * 显示成「还没编号」。
 */
export const FRONTMATTER_SCAN_LIMIT = 32 * 1024

/** `---` 那一行（允许尾部有空白） */
const FENCE = /^-{3,}\s*$/

/**
 * 数据块里一个字段值最多追多少行续行。
 *
 * 上限存在的意义只有一个：手改坏的文件里一条 `- ` 列表如果一直不结束，解析会一路
 * 吞到最后一行而让整份元数据消失。到这里就停下，当作这个字段读完了。
 */
const MAX_VALUE_LINES = 64

/**
 * 扫描期间用的一张单元格。
 *
 * 一个字段要么有自己的值（写在冒号后、或折行接着写），要么是一个块（`- ` 列表项，
 * 或者若干子字段），两种不会同时出现。
 */
export interface FrontmatterCell {
  /**
   * 字段自己的值。
   *
   * 两种来源：写在冒号后面的（`category: chapter`），以及折行接着写的那几行（多行用
   * `\n` 接起来）。
   */
  value?: string
  /** 这个字段底下直接写的 `- ` 行 */
  items?: string[]
  /** 这个字段底下更深的那些 `键: 值` 行（`data:` 底下那一层就是它） */
  children?: Map<string, FrontmatterCell>
}

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
 * 把一段 frontmatter 读成「字段 -> 那一格」。
 *
 * 只认文件最外层那几张字段；`---` 围栏本身在这里被跳过（它不是 `键: 值`），所以
 * `splitFrontmatter` 给的那一段可以**原样**交给它。
 */
export function parseFrontmatterFields(
  block: FrontmatterBlock | null
): Map<string, FrontmatterCell> {
  return block ? parseDocumentFields(block.raw) : new Map<string, FrontmatterCell>()
}

/**
 * 把**整份文本**读成「顶层字段 -> 那一格」。图鉴条目（整份文件就是属性）用它。
 *
 * 支持的范围刻意只有两层，与写出去的那一档严格对称：
 *
 * ```
 * category: chapter     <- 顶层字段：值
 * data:                 <- 顶层字段：一段缩进的内容，它自己又是一节「键: 值」
 *   index: "003"
 *   characters:         <- 子字段：底下是一列 `- ` 项
 *     - 主角
 * ```
 *
 * 这一层只负责**顶层**：数字段、把每个字段缩进的那一段原样收下（`readBlockTail`）。
 * 第二层（`data:` 里面有哪些键）交给调用方用同一套规则再解析一遍 —— 分两次而不是
 * 一次递归，是因为「一段缩进的内容」在两层里的含义不同：顶层那一段是「若干字段」，
 * 而字段底下那一段是「这个字段的值」（可能折行、也可能是列表）。
 *
 * 读不出来的行**跳过**，不让整份元数据作废（手改一行坏掉不该让章节失去编号与概述）；
 * 这一层的调用方只关心自己认得的那几个键，认不出来的键本来就不该被解释。
 *
 * 缩进用「比父级更深」判断，不要求空格数正好是 2 的倍数 —— 手写文件里 2 空、4 空
 * 都常见，而这里只需要知道「谁在谁里面」。
 */
export function parseDocumentFields(text: string): Map<string, FrontmatterCell> {
  const fields = new Map<string, FrontmatterCell>()
  if (typeof text !== 'string' || text.length === 0) return fields

  const source = text.startsWith('\uFEFF') ? text.slice(1) : text
  const lines = source.split(/\r?\n/)

  let index = 0
  const end = lines.length

  while (index < end) {
    const line = lines[index]
    index += 1

    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue

    // 缩进过的行在这一层没有归属：它属于上面那个字段的值，由 readBlockTail 收走
    if (/^\s/.test(line)) continue

    const field = parseFieldLine(trimmed)
    if (!field) continue

    if (field.value.length > 0) {
      fields.set(field.name, { value: field.value })
      continue
    }

    const tail = readBlockTail(lines, index, end, 0)
    fields.set(field.name, tail.cell)
    // 接着读这一段之后的行：那里可能还有顶层的字段（值写在块前面的写法就是这样）
    index = tail.next
  }

  return fields
}

/**
 * 一行 `键: 值`。
 *
 * 键的写法比 YAML 宽松、又比「冒号左边什么都算」严格，三条都是有理由的：
 *
 * - **允许非 ASCII**：图鉴的字段名就是中文的（`名称`、`外貌`），而字段名要写进
 *   用户的文件，逼人用英文键等于把显示名再翻一遍；
 * - **不许含空白**：折行的普通文本里出现的 `见 http://x` 因此不会被认成一个字段
 *   （键里带空格），而是接着算上一个字段的续行 —— 这一档读不出来的行只是跳过；
 * - **不许以引号、`-`、`#` 或 YAML 的结构字符开头**：那些是这一档不写的别的写法，
 *   认下来只会得到一个名字里带引号的字段。
 */
const FIELD_LINE = /^([^\s:#\-&*!|>%@`{}[\]"'][^\s:]*)\s*:\s*(.*)$/

function parseFieldLine(trimmed: string): { name: string; value: string } | null {
  const match = FIELD_LINE.exec(trimmed)
  if (!match) return null

  return { name: match[1], value: match[2].trim() }
}

/**
 * 缩进宽度（空格数与制表符折算）。
 *
 * 这一层只比较「谁更深」，不要求每级正好是 2 或 4 个空格 —— 手写的文件里两种都常见，
 * 而这里需要知道的只是父子关系。
 */
function indentOf(line: string): number {
  let width = 0

  for (const char of line) {
    if (char === ' ') width += 1
    else if (char === '\t') width += 4
    else break
  }

  return width
}

/** 空格与注释行：它们既不结束一段，也不算内容 */
function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.length === 0 || trimmed.startsWith('#')
}

/**
 * 读一个字段底下缩进的那一段，并报出「接着往下读的那一行」。
 *
 * ## 一段从哪儿开始、到哪儿结束
 *
 * 判据只有一条：**内容必须比父级更深**。
 *
 * - 开始：从 `from` 往后找到第一行缩进**深于 `parent`** 的内容行，它的缩进就是本段的
 *   `base`（比父级深、但不一定只深一级：手写文件里 2 空、4 空都常见）；
 * - 结束：遇到缩进 **≤ `parent`** 的行 —— 那一行回到了父级那一层，属于外面，留给调用方。
 *
 * 拿父级当基准（而不是拿本段第一行当基准）是这一段唯一容易写错的地方，两种错都在开发
 * 中真的出现过：拿本段第一行当基准时，`data:` 与它的第一个字段同缩进，于是「同缩进就
 * 结束」会让 `data:` 一个字段都读不到，而放宽成「更浅才结束」又会让角色列表一路吃到
 * 后面每一个字段（`notes`、`summary` 整段消失）。以父级为界，这两种情形就都落在同一条
 * 规则里了。
 *
 * ## 三种内容各归各处
 *
 * - `- 值` -> `items`（列表项）；
 * - `键: 值` -> `children` 里的一项；只写 `键:` 时它的值在更深的缩进里，递归收它；
 * - 其余非空行 -> 折行的长值，多行用 `\n` 接起来。
 *
 * ```
 * data:                  <- parent 这一层
 *   outline: 第一行       <- base（比 parent 深）；值是冒号后那一段
 *     第二行             <- 更深，同一字段的续行
 *   characters:           <- 同一个 base；值在下面
 *     - 主角             <- 更深，属于 characters
 *   notes: 备注           <- 同一个 base；仍是 data 的子字段
 * ---                     <- 回到 parent 那一层：本段结束
 * ```
 *
 * 三种混在一处时全都保留，读的一侧按自己认得的字段各取所需（章节元数据只从 `children`
 * 里取字段、从 `items` 里取角色），它们不会互相污染。
 *
 * `next` 是**接着往下读的那一行的下标**。它在两种情形下都不是「停下的那一行 + 1」：
 * 停下是因为缩进回到了父级时给出那一行自己（它属于外面）；停下是因为读到了围栏时给出
 * 最后一行内容之后的位置（末尾的空行不算内容，否则外层会以为还没读完）。
 */
function readBlockTail(
  lines: readonly string[],
  from: number,
  end: number,
  parent: number
): { cell: FrontmatterCell; next: number } {
  const values: string[] = []
  const items: string[] = []
  const children = new Map<string, FrontmatterCell>()

  let index = from
  let read = 0
  // 最后一个非空内容的下一行：读到头时用它把末尾的空行还回去
  let close = from
  // 本段的缩进层级：由第一行**深于父级**的内容定下来
  let base: number | null = null

  while (index < end && read < MAX_VALUE_LINES) {
    const raw = lines[index]

    if (isBlankOrComment(raw)) {
      index += 1
      read += 1
      continue
    }

    const indent = indentOf(raw)

    if (base === null) {
      // 与父级同层（或更浅）的行不属于本段：这个字段底下什么都没写
      if (indent <= parent) break
      base = indent
    }
    // 回到父级那一层：本段到此为止，这一行留给调用方（**先量后判**，别消费它）
    else if (indent <= parent) break

    index += 1
    read += 1
    close = index

    const text = raw.trim()
    const item = /^-\s*(.*)$/.exec(text)
    if (item) {
      items.push(item[1].trim())
      continue
    }

    const field = parseFieldLine(text)
    if (field) {
      /**
       * 子字段。它底下那一段以本段的 `base` 为父级：
       *
       * - **值写在冒号后**（`outline: 第一行`）：续行可以与它**同缩进**，而「同缩进」
       *   正是子段的边界 —— 于是续行会被收进来，值完整；
       * - **只写了键**（`characters:`）：值一定更深（列表项比它深一级），所以它的第一
       *   行不会落在边界上，会被正常收成子段的内容。
       *
       * 合并顺序：先放冒号后那一段，再由子段的结果覆盖它 —— 子段里收着续行（有的话），
       * 那才是完整的值。
       */
      const nested = readBlockTail(lines, index, end, base)
      /**
       * 冒号后那一段 + 子段里收着的续行 = 完整的值。
       *
       * 拼法是「一段原样文本」那一档：续行只是给人看的折行，读回来时接在上一行之后。
       * 只有一段时不必拼接（拼接会在值末尾多出一个换行）。
       */
      const cell: FrontmatterCell =
        field.value.length === 0
          ? nested.cell
          : nested.cell.value === undefined
            ? { ...nested.cell, value: field.value }
            : { ...nested.cell, value: `${field.value}\n${nested.cell.value}` }

      children.set(field.name, cell)
      index = nested.next
      close = index
      continue
    }

    values.push(text)
  }

  return {
    cell: {
      ...(values.length === 0 ? {} : { value: values.join('\n') }),
      ...(items.length === 0 ? {} : { items }),
      ...(children.size === 0 ? {} : { children })
    },
    // 读到头（不是被父级的行打断）时，末尾的空行不属于这一段
    next: index >= end ? Math.max(from, close) : index
  }
}
