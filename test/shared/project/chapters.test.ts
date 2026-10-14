import { describe, expect, it } from 'vitest'
import {
  CHAPTER_FIELD,
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
  usedChapterNumbers
} from '@shared/project'
import type { ChapterFile } from '@shared/project'

/**
 * 章节 Markdown 的开头属性（frontmatter）。
 *
 * 这一段逻辑决定「这是第几章」，而章节号**刻意不从文件名推**：文件名是用户可以随时
 * 改的显示名，编号是正文的元数据。所以这里测的是「读文件里那个值」这一件事，
 * 以及它的两个反面：读不出来时不该当成 0、也不该当成错误。
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
  it('读得出手写的裸数字与宿主写的引号形式', () => {
    expect(parseChapterNumber('---\nchapter: 3\n---\n')).toBe(3)
    expect(parseChapterNumber('---\nchapter: "3"\n---\n')).toBe(3)
  })

  it('补零的写法照样读得出（宿主写的是 003）', () => {
    expect(parseChapterNumber('---\nchapter: 007\n---\n')).toBe(7)
  })

  it('别的键不影响', () => {
    const text = '---\nstatus: 草稿\nchapter: 12\nviewpoint: 主角\n---\n'

    expect(parseChapterNumber(text)).toBe(12)
  })

  it('没有 frontmatter / 没有这个键 / 值不是正整数时都给 null', () => {
    expect(parseChapterNumber('# 第一章\n\n正文')).toBeNull()
    expect(parseChapterNumber('---\nstatus: 草稿\n---\n')).toBeNull()
    expect(parseChapterNumber('---\nchapter: 零\n---\n')).toBeNull()
    expect(parseChapterNumber('---\nchapter: 0\n---\n')).toBeNull()
    expect(parseChapterNumber('---\nchapter: -1\n---\n')).toBeNull()
    expect(parseChapterNumber('---\nchapter: 1.5\n---\n')).toBeNull()
  })

  it('重复的键取第一个', () => {
    expect(parseChapterNumber('---\nchapter: 2\nchapter: 9\n---\n')).toBe(2)
  })

  it('键的大小写敏感：Chapter 不是 chapter', () => {
    expect(parseChapterNumber('---\nChapter: 4\n---\n')).toBeNull()
  })
})

describe('composeChapterDocument', () => {
  it('写出宿主认得的形状：章节属性 + 一级标题，号补到三位', () => {
    expect(composeChapterDocument(3)).toBe(
      `---\n${CHAPTER_FIELD}: 003\n---\n\n# ${defaultChapterHeading(3)}\n\n`
    )
  })

  it('写出来的东西能读回来（同一份实现的两端对得上）', () => {
    for (const value of [1, 9, 10, 999, 1000]) {
      const document = composeChapterDocument(value)

      expect(parseChapterNumber(document)).toBe(value)
      // 列表里显示的就是这个标题，所以它必须建完就有
      expect(parseChapterHeading(document)).toBe(defaultChapterHeading(value))
    }
  })
})

describe('parseChapterHeading', () => {
  it('取正文里的一级标题', () => {
    expect(parseChapterHeading('---\nchapter: 1\n---\n\n# 决战前夜\n\n正文')).toBe('决战前夜')
  })

  it('只认一级标题：二级标题是分节，不是章名', () => {
    expect(parseChapterHeading('# 第一章\n\n## 第一节\n')).toBe('第一章')
    expect(parseChapterHeading('## 第一节\n')).toBeNull()
  })

  it('标题不必紧跟在 frontmatter 之后', () => {
    expect(parseChapterHeading('---\nchapter: 2\n---\n\n序言一段。\n\n# 真正的标题\n')).toBe(
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
    expect(parseChapterHeading('---\nchapter: 1\n---\n\n只有正文')).toBeNull()
    expect(parseChapterHeading('')).toBeNull()
  })
})

describe('章节号的计算', () => {
  it('取已用号的最大值，缺号的若干篇不参与', () => {
    expect(highestChapterNumber([1, 3, null, 2])).toBe(3)
    expect(highestChapterNumber([null, null])).toBe(0)
    expect(highestChapterNumber([])).toBe(0)
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
})
