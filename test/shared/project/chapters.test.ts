import { describe, expect, it } from 'vitest'
import {
  CHAPTER_CATEGORY_FIELD,
  CHAPTER_DATA_FIELD,
  CHAPTER_INDEX_FIELD,
  chapterBodyOf,
  chapterNumberFromFileName,
  composeChapterDocument,
  defaultChapterFileName,
  defaultChapterHeading,
  formatChapterNumber,
  highestChapterNumber,
  nextChapterNumber,
  parseChapterHeading,
  parseChapterNumber,
  splitFrontmatter,
  takenChapterFileNumbers,
  usedChapterNumbers,
  writeChapterBody
} from '@nide/contracts/project'
import type { ChapterFile } from '@nide/contracts/project'

/**
 * 章节 Markdown 的开头属性（frontmatter）里的**编号**。
 *
 * 这一段决定「这是第几章」，而章节号**刻意不从文件名推**：文件名是用户可以随时改的
 * 显示名，编号是正文的元数据。所以这里测的是「读文件里那个值」这一件事，以及它的
 * 两个反面：读不出来时不该当成 0、也不该当成错误。
 *
 * 元数据的完整形状（细纲、出场角色、备注、概述）在 chapter-metadata.test.ts 里测，
 * 这一份只覆盖与「第几章」有关的那些。
 */
describe('splitFrontmatter', () => {
  it('拆出 frontmatter 与它之后的正文', () => {
    const block = splitFrontmatter('---\nchapter: 1\n---\n正文')

    expect(block?.raw).toBe('---\nchapter: 1\n---')
    expect(block?.rest).toBe('正文')
  })

  it('首行不是围栏时不算 frontmatter（正文里的分隔线不能被当成开头）', () => {
    expect(splitFrontmatter('正文\n\n---\n\n后半篇')).toBeNull()
  })

  it('没有收尾围栏时给 null，而不是把整个文件当 frontmatter', () => {
    expect(splitFrontmatter('---\nchapter: 1\n正文')).toBeNull()
  })

  it('认 CRLF 与 BOM（Windows 上的编辑器会给）', () => {
    const block = splitFrontmatter('\uFEFF---\r\nchapter: 2\r\n---\r\n正文')

    expect(block?.raw).toBe('---\nchapter: 2\n---')
    expect(block?.rest).toBe('正文')
  })

  it('空内容给 null', () => {
    expect(splitFrontmatter('')).toBeNull()
  })
})

describe('parseChapterNumber', () => {
  it('读数据块里的编号：补零的与手写的裸数字都认', () => {
    expect(parseChapterNumber('---\ndata:\n  index: "003"\n---\n')).toBe(3)
    expect(parseChapterNumber('---\ndata:\n  index: 3\n---\n')).toBe(3)
  })

  it('0 是序章，是一个合法编号', () => {
    expect(parseChapterNumber('---\ndata:\n  index: "0"\n---\n')).toBe(0)
  })

  it('别的键不影响', () => {
    const text = '---\ncategory: chapter\ndata:\n  outline: 草稿\n  index: 12\n  notes: 备忘\n---\n'

    expect(parseChapterNumber(text)).toBe(12)
  })

  it('没有 frontmatter / 没有这个键 / 值不是整数时都给 null', () => {
    expect(parseChapterNumber('# 第一章\n\n正文')).toBeNull()
    expect(
      parseChapterNumber('---\ncategory: chapter\ndata:\n  outline: 只有细纲\n---\n')
    ).toBeNull()
    expect(parseChapterNumber('---\ndata:\n  index: 零\n---\n')).toBeNull()
    expect(parseChapterNumber('---\ndata:\n  index: -1\n---\n')).toBeNull()
    expect(parseChapterNumber('---\ndata:\n  index: 1.5\n---\n')).toBeNull()
  })

  it('旧写法（顶层的 chapter 键）不再认：宿主只认新结构', () => {
    expect(parseChapterNumber('---\nchapter: 3\n---\n')).toBeNull()
    expect(parseChapterNumber('---\nchapter: 007\n---\n')).toBeNull()
  })

  it('键的大小写敏感：Index 不是 index', () => {
    expect(parseChapterNumber('---\ndata:\n  Index: 4\n---\n')).toBeNull()
  })
})

describe('composeChapterDocument', () => {
  it('写出宿主认得的形状：类别 + 数据块 + 一级标题，号补到三位', () => {
    expect(composeChapterDocument(3)).toBe(
      [
        '---',
        `${CHAPTER_CATEGORY_FIELD}: "chapter"`,
        `${CHAPTER_DATA_FIELD}:`,
        `  ${CHAPTER_INDEX_FIELD}: "003"`,
        '---',
        '',
        `# ${defaultChapterHeading(3)}`,
        '',
        ''
      ].join('\n')
    )
  })

  it('写出来的东西能读回来（同一份实现的两端对得上）', () => {
    for (const value of [0, 1, 9, 10, 999, 1000]) {
      const document = composeChapterDocument(value)

      expect(parseChapterNumber(document)).toBe(value)
      // 列表里显示的就是这个标题，所以它必须建完就有
      expect(parseChapterHeading(document)).toBe(defaultChapterHeading(value))
    }
  })
})

describe('parseChapterHeading', () => {
  it('取正文里的一级标题', () => {
    expect(parseChapterHeading('---\ndata:\n  index: 1\n---\n\n# 决战前夜\n\n正文')).toBe(
      '决战前夜'
    )
  })

  it('只认一级标题：二级标题是分节，不是章名', () => {
    expect(parseChapterHeading('# 第一章\n\n## 第一节\n')).toBe('第一章')
    expect(parseChapterHeading('## 第一节\n')).toBeNull()
  })

  it('标题不必紧跟在 frontmatter 之后', () => {
    expect(parseChapterHeading('---\ndata:\n  index: 2\n---\n\n序言一段。\n\n# 真正的标题\n')).toBe(
      '真正的标题'
    )
  })

  it('代码围栏里的 # 是注释，不是标题', () => {
    const text = ['```bash', '# 注释', '```', '', '# 真标题', ''].join('\n')

    expect(parseChapterHeading(text)).toBe('真标题')
  })

  it('空标题（只有 #）不算', () => {
    expect(parseChapterHeading('#\n\n# 有名字\n')).toBe('有名字')
    expect(parseChapterHeading('#   \n')).toBeNull()
  })

  it('没有标题时给 null', () => {
    expect(parseChapterHeading('---\ndata:\n  index: 1\n---\n\n只有正文')).toBeNull()
    expect(parseChapterHeading('')).toBeNull()
  })
})

describe('章节号的计算', () => {
  it('取已用号的最大值，缺号的若干篇不参与', () => {
    expect(highestChapterNumber([1, 3, null, 2])).toBe(3)
    expect(highestChapterNumber([null, null])).toBe(0)
    expect(highestChapterNumber([])).toBe(0)
  })

  it('序章（0）不抬高结果：下一个正式章节仍然是第 1 章', () => {
    expect(highestChapterNumber([0])).toBe(0)
    expect(highestChapterNumber([0, 1, 2])).toBe(2)
    expect(nextChapterNumber([0])).toBe(1)
  })

  it('下一个号是最大值 + 1', () => {
    expect(nextChapterNumber([1, 2, 3])).toBe(4)
    expect(nextChapterNumber([])).toBe(1)
  })

  it('删掉中间某一章之后不会重复用号', () => {
    // 1、3 还在（2 被删了）：下一个是 4，而不是 3
    expect(nextChapterNumber([1, 3])).toBe(4)
  })

  it('躲开已经被占用的默认文件名（那一篇可能没有 frontmatter）', () => {
    // 文件里有 chapter_1.md 与 chapter_2.md，但只有第一篇写得出号
    expect(nextChapterNumber([1], [1, 2])).toBe(3)
    expect(nextChapterNumber([1, 2, 5], [1, 2, 5])).toBe(6)
  })

  it('文件名的数字是别的形状时不影响', () => {
    expect(nextChapterNumber([1], [1, 2, 3])).toBe(4)
  })
})

describe('默认文件名', () => {
  it('形如 chapter_1.md', () => {
    expect(defaultChapterFileName(1)).toBe('chapter_1.md')
    expect(defaultChapterFileName(12)).toBe('chapter_12.md')
  })

  it('文件名里的号读得回来', () => {
    expect(chapterNumberFromFileName('chapter_1.md')).toBe(1)
    expect(chapterNumberFromFileName('Chapter_012.MD')).toBe(12)
  })

  it('用户自己起的名字与别的扩展名都读不出来', () => {
    expect(chapterNumberFromFileName('决战前夜.md')).toBeNull()
    expect(chapterNumberFromFileName('chapter_1.txt')).toBeNull()
    expect(chapterNumberFromFileName('chapter_.md')).toBeNull()
    expect(chapterNumberFromFileName('chapter_1.md.bak')).toBeNull()
  })
})

describe('从章节列表里取两件事', () => {
  const files: ChapterFile[] = [
    { path: '/p/chapters/chapter_1.md', name: 'chapter_1.md', chapter: 1, heading: 'Chapter 1' },
    // 被删掉过 frontmatter 的那一篇：文件还在，号读不出来
    { path: '/p/chapters/chapter_2.md', name: 'chapter_2.md', chapter: null, heading: null },
    { path: '/p/chapters/决战前夜.md', name: '决战前夜.md', chapter: 7, heading: '决战前夜' }
  ]

  it('已用编号含读不出来的那些位置', () => {
    expect(usedChapterNumbers(files)).toEqual([1, null, 7])
  })

  it('被占用的默认文件名只认 chapter_<数字>.md', () => {
    expect(takenChapterFileNumbers(files)).toEqual([1, 2])
  })

  it('两件事合起来给出的下一个号躲得开重名', () => {
    // 最大号是 7，但 chapter_2.md 这个文件名还在 —— 这里给 8，不受它影响
    expect(nextChapterNumber(usedChapterNumbers(files), takenChapterFileNumbers(files))).toBe(8)
  })
})

describe('formatChapterNumber', () => {
  it('补到三位；更长的不截断', () => {
    expect(formatChapterNumber(1)).toBe('001')
    expect(formatChapterNumber(42)).toBe('042')
    expect(formatChapterNumber(1000)).toBe('1000')
  })

  it('序章写出来是 000', () => {
    expect(formatChapterNumber(0)).toBe('000')
  })
})

describe('chapterBodyOf', () => {
  it('摘掉 frontmatter，并吃掉分隔用的那个空行', () => {
    expect(
      chapterBodyOf('---\ncategory: chapter\ndata:\n  index: "1"\n---\n\n# 标题\n\n正文')
    ).toBe('# 标题\n\n正文')
  })

  it('没有 frontmatter 时整篇就是正文', () => {
    expect(chapterBodyOf('# 随便写的一篇\n')).toBe('# 随便写的一篇\n')
  })

  it('只有 frontmatter 时正文是空串（预览据此显示「还没有正文」）', () => {
    expect(chapterBodyOf('---\ncategory: chapter\ndata:\n  index: "1"\n---\n')).toBe('')
  })

  it('首行不是围栏时不当 frontmatter：正文里的分隔线不会被吃掉', () => {
    expect(chapterBodyOf('正文\n\n---\n\n后半篇')).toBe('正文\n\n---\n\n后半篇')
  })

  it('宿主写出来的那一份里，正文就是一级标题之后的一切', () => {
    const document = composeChapterDocument(3)

    expect(chapterBodyOf(document)).toBe(`# ${defaultChapterHeading(3)}\n\n`)
  })
})

/**
 * 写回正文：表单模式里那个只认正文的编辑器每敲一个字都会走到这里。
 *
 * 这一组的判据只有一条 —— **读回来的正文与写进去的那份逐字相同**（除此之外文件的
 * 其余部分一点都不该动）。所以正面的用例都写成「往返一趟」，而不是各自盯着字符串的
 * 某个位置：位置会随着排版约定变，而往返不变。
 */
describe('writeChapterBody', () => {
  const DOCUMENT = '---\ncategory: chapter\ndata:\n  index: "001"\n---\n\n# 标题\n\n正文\n'

  it('只换正文，frontmatter 原样留下', () => {
    expect(writeChapterBody(DOCUMENT, '# 改过的标题\n\n改过的正文\n')).toBe(
      '---\ncategory: chapter\ndata:\n  index: "001"\n---\n\n# 改过的标题\n\n改过的正文\n'
    )
  })

  it('往返一趟读到的是同一段正文（空、单行、结尾没有换行都算）', () => {
    for (const body of ['', '# 标题', '# 标题\n', '第一段\n\n第二段\n', '\n以空行开头\n']) {
      expect(chapterBodyOf(writeChapterBody(DOCUMENT, body))).toBe(body)
    }
  })

  it('手写的那种没有空行的写法：写回一次就归到「围栏 + 空行 + 正文」', () => {
    const handwritten = '---\ncategory: chapter\n---\n# 标题\n\n正文'

    expect(writeChapterBody(handwritten, '正文')).toBe('---\ncategory: chapter\n---\n\n正文')
  })

  it('没有 frontmatter 时整篇就是正文：写回来也就是正文本身', () => {
    expect(writeChapterBody('# 随便写的一篇\n', '改写过的\n')).toBe('改写过的\n')
  })

  it('只有 frontmatter 时写进去的就是全部正文', () => {
    expect(writeChapterBody('---\ncategory: chapter\n---\n', '# 新的一章\n')).toBe(
      '---\ncategory: chapter\n---\n\n# 新的一章\n'
    )
  })

  it('正文里的分隔线不会被当成围栏：只有首行那一段算 frontmatter', () => {
    const body = '第一段\n\n---\n\n第二段\n'

    expect(chapterBodyOf(writeChapterBody(DOCUMENT, body))).toBe(body)
  })
})
