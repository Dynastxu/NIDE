import { describe, expect, it } from 'vitest'
import {
  canPreviewDocument,
  defaultDocumentMode,
  isChapterTab
} from '@renderer/editor/document-mode'
import { CHAPTER_CATEGORY, emptyChapterMetadata, type ChapterMetadata } from '@shared/project'

/**
 * 「这一篇能怎么看」的判据与默认值。
 *
 * 三条规则都在这里：能预览（Markdown）、是章节（frontmatter 里的类别）、以及没选过时
 * 默认停在哪个模式。它们决定标题栏上画几个按钮、正文按哪一种模式渲染 —— 判据分叉的
 * 表现是「按钮和正文说的不是同一件事」，那比少一个按钮糟得多。
 */
const chapter: ChapterMetadata = { ...emptyChapterMetadata(), category: CHAPTER_CATEGORY }
const note: ChapterMetadata = { ...emptyChapterMetadata(), category: 'note' }
const plain: ChapterMetadata = emptyChapterMetadata()

describe('canPreviewDocument', () => {
  it('Markdown 认扩展名，也认 Monaco 给出的语言 id', () => {
    expect(canPreviewDocument('markdown', '/p/chapters/a.md')).toBe(true)
    // 语言 id 还没跟上（刚改名）时按扩展名判：预览不该因为一次改名而消失
    expect(canPreviewDocument('plaintext', '/p/chapters/a.markdown')).toBe(true)
  })

  it('非 Markdown 不能预览：一组点了没反应的按钮不如不画', () => {
    expect(canPreviewDocument('plaintext', '/p/notes.txt')).toBe(false)
    expect(canPreviewDocument('json', '/p/data.json')).toBe(false)
  })
})

describe('isChapterTab', () => {
  it('写着章节类别的 Markdown 才是章节', () => {
    expect(isChapterTab('markdown', '/p/chapters/a.md', chapter)).toBe(true)
  })

  it('没有类别、或者类别是别的值时都不是章节（表单按钮不该出现）', () => {
    expect(isChapterTab('markdown', '/p/README.md', plain)).toBe(false)
    expect(isChapterTab('markdown', '/p/gallery/某人.md', note)).toBe(false)
    // 类别对了但文件不是 Markdown：预览都没有，更谈不上表单
    expect(isChapterTab('plaintext', '/p/chapters/a.txt', chapter)).toBe(false)
  })
})

describe('defaultDocumentMode', () => {
  it('章节默认表单（写作时改的多半是元数据）', () => {
    expect(defaultDocumentMode('markdown', '/p/chapters/a.md', chapter)).toBe('form')
  })

  it('其余 Markdown 默认预览（打开它是为了读，不是为了改）', () => {
    expect(defaultDocumentMode('markdown', '/p/README.md', plain)).toBe('preview')
    expect(defaultDocumentMode('markdown', '/p/gallery/某人.md', note)).toBe('preview')
  })

  it('非 Markdown 一律纯文本', () => {
    expect(defaultDocumentMode('json', '/p/data.json', plain)).toBe('text')
    expect(defaultDocumentMode('json', '/p/data.json', chapter)).toBe('text')
  })
})
