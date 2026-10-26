import { describe, expect, it } from 'vitest'
import {
  CHAPTER_CATEGORY,
  CHAPTER_CATEGORY_FIELD,
  CHAPTER_CHARACTERS_FIELD,
  CHAPTER_DATA_FIELD,
  CHAPTER_INDEX_FIELD,
  CHAPTER_NOTES_FIELD,
  CHAPTER_OUTLINE_FIELD,
  CHAPTER_SUMMARY_FIELD,
  emptyChapterMetadata,
  formatChapterMetadata,
  readChapterMetadata,
  writeChapterMetadata,
  type ChapterMetadata
} from '@nide/contracts/project'

/**
 * 章节元数据（frontmatter 里的 `category` + `data` 那一段）。
 *
 * 这一段决定「这是第几章、细纲是什么、出场角色有谁」，而它的两件事都要紧：
 * **读得回来**（列表与表单都靠它）与**写得回去**（只碰开头那一块，正文一个字不能动）。
 * 所以用例分三组：解析、写回、以及两者之间的往返。
 *
 * 边界上最值得钉住的是编号的三种状态：`0`（序章）、正整数、`null`（还没编号）。
 * 它们看起来都像「一个数字」，但界面上分别是 `0`、`3`、`—`。
 */
const metadata = (overrides: Partial<ChapterMetadata> = {}): ChapterMetadata => ({
  ...emptyChapterMetadata(),
  category: CHAPTER_CATEGORY,
  ...overrides
})

/** 宿主写出来的那种形状：文件头那份注释画的就是它，用例照着它读会更直观 */
const DOCUMENT = [
  '---',
  'category: chapter',
  'data:',
  '  index: "003"',
  '  outline: 主角第一次见到对手',
  '  characters:',
  '    - 主角',
  '    - 对手',
  '  notes: 这一章要压住节奏',
  '  summary: 相遇',
  '---',
  '',
  '# Chapter 3',
  '',
  '正文'
].join('\n')

describe('readChapterMetadata', () => {
  it('读出数据块里的每一项', () => {
    expect(readChapterMetadata(DOCUMENT)).toEqual({
      category: 'chapter',
      index: 3,
      outline: '主角第一次见到对手',
      characters: ['主角', '对手'],
      notes: '这一章要压住节奏',
      summary: '相遇'
    })
  })

  it('编号的三种状态：0 是序章、正整数是章、读不出来是「还没编号」', () => {
    expect(readChapterMetadata('---\ncategory: chapter\ndata:\n  index: "0"\n---\n').index).toBe(0)
    expect(readChapterMetadata('---\ncategory: chapter\ndata:\n  index: 12\n---\n').index).toBe(12)
    expect(readChapterMetadata('---\ncategory: chapter\ndata:\n---\n').index).toBeNull()
    expect(
      readChapterMetadata('---\ncategory: chapter\ndata:\n  index: 序\n---\n').index
    ).toBeNull()
    expect(
      readChapterMetadata('---\ncategory: chapter\ndata:\n  index: -1\n---\n').index
    ).toBeNull()
    expect(
      readChapterMetadata('---\ncategory: chapter\ndata:\n  index: 1.5\n---\n').index
    ).toBeNull()
  })

  it('角色列表去掉重复，保留原来的先后', () => {
    const text =
      '---\ncategory: chapter\ndata:\n  characters:\n    - 主角\n    - 对手\n    - 主角\n---\n'

    expect(readChapterMetadata(text).characters).toEqual(['主角', '对手'])
  })

  it('没有 frontmatter / 没有 data 块时给一份空的，而不是抛', () => {
    expect(readChapterMetadata('# 随便写的一篇\n')).toEqual(emptyChapterMetadata())
    expect(readChapterMetadata('')).toEqual(emptyChapterMetadata())
    expect(readChapterMetadata('---\ncategory: chapter\n---\n').index).toBeNull()
  })

  it('类别是别的值时照读（是不是章节由 isChapterDocument 判，见 document-mode）', () => {
    const text = '---\ncategory: gallery\ndata:\n  index: "007"\n---\n'

    expect(readChapterMetadata(text).category).toBe('gallery')
    expect(readChapterMetadata(text).index).toBe(7)
  })

  it('顶层同名字段在没有数据块时也认（手写的文件不必先学会两层写法）', () => {
    const text = '---\ncategory: chapter\noutline: 手写的细纲\n---\n'

    expect(readChapterMetadata(text).outline).toBe('手写的细纲')
  })

  it('带引号的值去掉引号，裸值原样收下（两种写法都认）', () => {
    const quoted =
      '---\ncategory: "chapter"\ndata:\n  index: "003"\n  outline: "带 \\"引号\\" 的细纲"\n---\n'
    const bare = '---\ncategory: chapter\ndata:\n  index: 3\n  outline: 裸写的细纲\n---\n'

    expect(readChapterMetadata(quoted)).toEqual({
      ...emptyChapterMetadata(),
      category: 'chapter',
      index: 3,
      outline: '带 "引号" 的细纲'
    })
    expect(readChapterMetadata(bare)).toEqual({
      ...emptyChapterMetadata(),
      category: 'chapter',
      index: 3,
      outline: '裸写的细纲'
    })
  })

  it('嵌套的列表不会吃掉它后面的兄弟字段', () => {
    /**
     * 这是「按缩进判边界」那条规则最容易坏的地方：角色列表读到最后一个 `- 对手` 之后，
     * 紧接着是缩进更浅（但仍属于数据块）的 `notes`。把那一行当成列表的一部分，备注与
     * 概述就会整段消失 —— 而它们看起来都还在文件里。
     */
    const text = [
      '---',
      'category: chapter',
      'data:',
      '  characters:',
      '    - 主角',
      '    - 对手',
      '  notes: 备注还在',
      '  summary: 概述也在',
      '---',
      ''
    ].join('\n')

    const metadata = readChapterMetadata(text)

    expect(metadata.characters).toEqual(['主角', '对手'])
    expect(metadata.notes).toBe('备注还在')
    expect(metadata.summary).toBe('概述也在')
  })

  it('块之后还有顶层字段时也读得到（值写在块前面的写法）', () => {
    const text = '---\ndata:\n  index: "005"\ncategory: chapter\n---\n'

    expect(readChapterMetadata(text).index).toBe(5)
    expect(readChapterMetadata(text).category).toBe('chapter')
  })

  it('折行写出来的长值用换行接起来', () => {
    const text = '---\ncategory: chapter\ndata:\n  outline: 第一行\n    第二行\n---\n'

    expect(readChapterMetadata(text).outline).toBe('第一行\n第二行')
  })
})

describe('writeChapterMetadata', () => {
  it('只换 frontmatter，正文一行都不动', () => {
    const next = writeChapterMetadata(DOCUMENT, metadata({ index: 4, summary: '改过的概述' }))
    const lines = next.split('\n')

    expect(lines[0]).toBe('---')
    expect(lines).toContain(`${CHAPTER_CATEGORY_FIELD}: "chapter"`)
    expect(lines).toContain(`  ${CHAPTER_INDEX_FIELD}: "004"`)
    expect(lines).toContain(`  ${CHAPTER_SUMMARY_FIELD}: "改过的概述"`)
    expect(next.endsWith('\n# Chapter 3\n\n正文')).toBe(true)
  })

  it('原来没有 frontmatter 时补一块出来，正文跟在下面', () => {
    const next = writeChapterMetadata('# 决战前夜\n\n正文', metadata({ index: 7 }))

    expect(next.startsWith('---\ncategory: "chapter"\ndata:\n  index: "007"\n---\n\n#')).toBe(true)
    expect(next.endsWith('正文')).toBe(true)
  })

  it('没值的字段不写出来：一个空字段不等于「这里就是空的」', () => {
    const text = writeChapterMetadata('', metadata({ index: 1 }))

    expect(text).not.toContain(`${CHAPTER_OUTLINE_FIELD}:`)
    expect(text).not.toContain(`${CHAPTER_CHARACTERS_FIELD}:`)
    expect(text).not.toContain(`${CHAPTER_NOTES_FIELD}:`)
    expect(text).not.toContain(`${CHAPTER_SUMMARY_FIELD}:`)
    // 数据块那一行本身仍然在：它说的是「这篇有元数据块，只是还空着」
    expect(text).toContain(`${CHAPTER_DATA_FIELD}:`)
  })

  it('写出来的东西能读回来（同一份实现的两端对得上）', () => {
    const before = metadata({
      index: 12,
      outline: '带 "引号" 与 \\反斜杠 的细纲',
      characters: ['主角', '对手'],
      notes: '备注',
      summary: '概述'
    })

    expect(readChapterMetadata(writeChapterMetadata(DOCUMENT, before))).toEqual(before)
  })

  it('多行文本能原样往返（细纲、备注里换行是常事）', () => {
    const before = metadata({
      index: 1,
      outline: '第一行\n第二行',
      notes: '备注第一行\n备注第二行'
    })
    const written = writeChapterMetadata(DOCUMENT, before)

    // 换行必须转义，否则下一行会被当成结构（这是本格式唯一会给文书写坏的地方）
    expect(written).toContain('\\n')
    expect(readChapterMetadata(written)).toEqual(before)
  })

  it('行尾固定用 \\n：混用行尾是 diff 里最常见的噪声', () => {
    expect(writeChapterMetadata('', metadata({ index: 1 }))).not.toContain('\r')
  })

  it('formatChapterMetadata 给出 frontmatter 里的那几行，且与写回结果一致', () => {
    const value = metadata({ index: 1 })
    const lines = formatChapterMetadata(value)

    expect(lines[0]).toBe(`${CHAPTER_CATEGORY_FIELD}: "chapter"`)
    expect(lines[1]).toBe(`${CHAPTER_DATA_FIELD}:`)
    expect(writeChapterMetadata('', value)).toBe(`---\n${lines.join('\n')}\n---\n`)
  })
})
