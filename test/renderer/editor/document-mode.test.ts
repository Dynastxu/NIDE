import { describe, expect, it } from 'vitest'
import {
  availableDocumentModes,
  canPreviewDocument,
  defaultDocumentModeOf,
  documentKindOf,
  documentViewOf,
  isChapterTab,
  isForeshadowingTab,
  isGalleryConfigTab,
  isGalleryEntryTab,
  resolveDocumentMode,
  type DocumentView,
  type DocumentViewInput
} from '@nide/client-ui-main/editor/document-mode'
import {
  CHAPTER_CATEGORY,
  DEFAULT_GALLERY_FIELDS,
  emptyChapterMetadata,
  emptyForeshadowingMetadata,
  emptyGalleryEntry,
  FORESHADOWING_CATEGORY,
  GALLERY_CATEGORY,
  type ChapterMetadata,
  type ForeshadowingMetadata,
  type GalleryConfig,
  type GalleryEntryDocument
} from '@nide/contracts/project'

/**
 * 「这一篇能怎么看」的判据与默认值。
 *
 * 三类东西各有一套判据（Markdown 能不能预览、是不是章节、是不是图鉴的两种 yml），它们
 * 决定标题栏上画几个按钮、正文按哪一种模式渲染 —— 判据分叉的表现是「按钮和正文说的不是
 * 一件事」，那比少一个按钮糟得多。
 *
 * 图鉴那两条还多一层：**判据的另一半在文件内容里**（`category: gallery`、以及
 * `config.yml` 里那张字段表）。一个写着图鉴类别但不是 yml 的文件、一个叫 `config.yml`
 * 却读不出字段表的文件，都不该拿到图鉴表单 —— 表单会把整份文件按它认得的形状重写。
 */

const chapter: ChapterMetadata = { ...emptyChapterMetadata(), category: CHAPTER_CATEGORY }
const note: ChapterMetadata = { ...emptyChapterMetadata(), category: 'note' }
const plain: ChapterMetadata = emptyChapterMetadata()

const foreshadowing: ForeshadowingMetadata = {
  ...emptyForeshadowingMetadata(),
  category: FORESHADOWING_CATEGORY
}

const galleryEntry: GalleryEntryDocument = { ...emptyGalleryEntry(), category: GALLERY_CATEGORY }
const galleryConfig: GalleryConfig = { fields: [...DEFAULT_GALLERY_FIELDS] }

/** 一份判据输入。默认是一篇普通 Markdown，用例只改自己关心的那一两项 */
function input(overrides: Partial<DocumentViewInput> = {}): DocumentViewInput {
  return {
    language: 'markdown',
    path: '/p/README.md',
    chapter: plain,
    foreshadowing: emptyForeshadowingMetadata(),
    gallery: emptyGalleryEntry(),
    galleryConfig: null,
    ...overrides
  }
}

describe('canPreviewDocument', () => {
  it('Markdown 认扩展名，也认 Monaco 给出的语言 id', () => {
    expect(canPreviewDocument('markdown', '/p/chapters/a.md')).toBe(true)
    // 语言 id 还没跟上（刚改名）时按扩展名判：预览不该因为一次改名而消失
    expect(canPreviewDocument('plaintext', '/p/chapters/a.markdown')).toBe(true)
  })

  it('非 Markdown 不能预览：一组点了没反应的按钮不如不画', () => {
    expect(canPreviewDocument('plaintext', '/p/notes.txt')).toBe(false)
    expect(canPreviewDocument('yaml', '/p/gallery/角色/主角.yml')).toBe(false)
  })
})

describe('章节的判据', () => {
  it('写着章节类别的 Markdown 才是章节', () => {
    expect(isChapterTab(input({ path: '/p/chapters/a.md', chapter }))).toBe(true)
  })

  it('没有类别、或者类别是别的值时都不是章节（表单按钮不该出现）', () => {
    expect(isChapterTab(input({ path: '/p/README.md' }))).toBe(false)
    expect(isChapterTab(input({ path: '/p/gallery/某人.md', chapter: note }))).toBe(false)
    // 类别对了但文件不是 Markdown：预览都没有，更谈不上表单
    expect(isChapterTab(input({ language: 'plaintext', path: '/p/chapters/a.txt', chapter }))).toBe(
      false
    )
  })
})

describe('伏笔的判据', () => {
  it('写着伏笔类别的 yml 才是伏笔', () => {
    expect(
      isForeshadowingTab(input({ language: 'yaml', path: '/p/foreshadowing/a.yml', foreshadowing }))
    ).toBe(true)
    expect(
      isForeshadowingTab(
        input({ language: 'yaml', path: '/p/foreshadowing/a.yaml', foreshadowing })
      )
    ).toBe(true)
  })

  it('没有类别、类别是别的值、或者不是 yml 时都不是伏笔', () => {
    expect(isForeshadowingTab(input({ language: 'yaml', path: '/p/foreshadowing/a.yml' }))).toBe(
      false
    )
    expect(
      isForeshadowingTab(
        input({
          language: 'yaml',
          path: '/p/foreshadowing/a.yml',
          foreshadowing: { ...foreshadowing, category: 'note' }
        })
      )
    ).toBe(false)
    // 类别对但文件不是 yml：表单会把整份文件按 YAML 重写，所以不能给表单
    expect(
      isForeshadowingTab(
        input({ language: 'markdown', path: '/p/foreshadowing/a.md', foreshadowing })
      )
    ).toBe(false)
    expect(
      isForeshadowingTab(
        input({ language: 'plaintext', path: '/p/foreshadowing/a.txt', foreshadowing })
      )
    ).toBe(false)
  })
})

describe('图鉴的判据', () => {
  it('写着图鉴类别的 yml 才是图鉴条目', () => {
    expect(
      isGalleryEntryTab(
        input({ language: 'yaml', path: '/p/gallery/角色/主角.yml', gallery: galleryEntry })
      )
    ).toBe(true)
  })

  it('写成图鉴类别但**不是 yml** 的不算：表单会把整份文件按 YAML 重写', () => {
    expect(
      isGalleryEntryTab(
        input({ language: 'markdown', path: '/p/gallery/角色/主角.md', gallery: galleryEntry })
      )
    ).toBe(false)
  })

  it('yml 里没有图鉴类别时只是一个普通的 yml', () => {
    expect(isGalleryEntryTab(input({ language: 'yaml', path: '/p/config.yml' }))).toBe(false)
  })

  it('config.yml 要**名字对、内容也读得出字段表**才算图鉴配置', () => {
    const config = input({
      language: 'yaml',
      path: '/p/gallery/角色/config.yml',
      galleryConfig
    })

    expect(isGalleryConfigTab(config)).toBe(true)
    // 名字对但读不出来：那多半是用户自己写坏的，此时该给纯文本让他去修
    expect(isGalleryConfigTab({ ...config, galleryConfig: null })).toBe(false)
    // 内容对但名字不是 config.yml：项目里任何一个 yml 都不该被当成图鉴配置
    expect(isGalleryConfigTab({ ...config, path: '/p/gallery/角色/别的.yml' })).toBe(false)
  })
})

describe('documentKindOf 与按钮组', () => {
  it('章节、伏笔与图鉴都能填表单，纯文本一个按钮都没有', () => {
    expect(documentKindOf(input({ path: '/p/chapters/a.md', chapter }))).toBe('chapter')
    expect(
      documentKindOf(input({ language: 'yaml', path: '/p/foreshadowing/a.yml', foreshadowing }))
    ).toBe('foreshadowing')
    expect(
      documentKindOf(input({ language: 'yaml', path: '/p/角色.yml', gallery: galleryEntry }))
    ).toBe('gallery-entry')
    expect(
      documentKindOf(input({ language: 'yaml', path: '/p/gallery/角色/config.yml', galleryConfig }))
    ).toBe('gallery-config')
    expect(documentKindOf(input())).toBe('markdown')
    expect(documentKindOf(input({ language: 'plaintext', path: '/p/notes.txt' }))).toBe('plain')

    expect(availableDocumentModes('chapter')).toEqual(['text', 'form', 'split', 'preview'])
    expect(availableDocumentModes('foreshadowing')).toEqual(['text', 'form'])
    expect(availableDocumentModes('markdown')).toEqual(['text', 'split', 'preview'])
    expect(availableDocumentModes('gallery-entry')).toEqual(['text', 'form'])
    expect(availableDocumentModes('gallery-config')).toEqual(['text', 'form'])
    expect(availableDocumentModes('plain')).toEqual([])
  })
})

describe('默认模式', () => {
  it('章节、伏笔与图鉴默认表单（打开它们就是为了改元数据）', () => {
    expect(defaultDocumentModeOf('chapter')).toBe('form')
    expect(defaultDocumentModeOf('foreshadowing')).toBe('form')
    expect(defaultDocumentModeOf('gallery-entry')).toBe('form')
    expect(defaultDocumentModeOf('gallery-config')).toBe('form')
  })

  it('其余 Markdown 默认预览（打开它是为了读），非 Markdown 一律纯文本', () => {
    expect(defaultDocumentModeOf('markdown')).toBe('preview')
    expect(defaultDocumentModeOf('plain')).toBe('text')
  })
})

describe('documentViewOf 与回落', () => {
  it('一份结论同时给出类别、按钮与默认模式', () => {
    const view = documentViewOf(input({ path: '/p/chapters/a.md', chapter }))

    expect(view).toEqual({
      kind: 'chapter',
      modes: ['text', 'form', 'split', 'preview'],
      defaultMode: 'form'
    })
  })

  it('存着的模式不在这一篇能给的里面时回落到默认值', () => {
    // 用户给它选过「拆分」，之后这个文件被改成了一份普通 yml —— 拆分不该还在
    const gallery: DocumentView = {
      kind: 'gallery-entry',
      modes: ['text', 'form'],
      defaultMode: 'form'
    }

    expect(resolveDocumentMode('split', gallery)).toBe('form')
    expect(resolveDocumentMode('text', gallery)).toBe('text')
    // 没选过（undefined）时也是默认值
    expect(resolveDocumentMode(undefined, gallery)).toBe('form')
  })
})
