import { describe, expect, it } from 'vitest'
import {
  composeForeshadowingEntry,
  DEFAULT_FORESHADOWING_EXTENSION,
  emptyForeshadowingMetadata,
  FORESHADOWING_CATEGORY,
  foreshadowingEntryLabel,
  formatForeshadowingEntry,
  isForeshadowingDocument,
  isForeshadowingPath,
  readForeshadowingEntry
} from '@shared/project'

/**
 * 伏笔的 yml：固定四个字段（名称 / 起始章节 / 结束章节 / 描述）。
 *
 * 这里测的是**两端对得上**：写出去的那一份必须能读回来，读的时候要认得手写的两种
 * 位置（`data` 底下与顶层），而扩展名只认 yml。
 */

const METADATA = {
  category: FORESHADOWING_CATEGORY,
  name: '主角的身世',
  startChapter: '003',
  endChapter: '012',
  description: '第一章埋下的玉佩，到第十二章才解释清楚。'
}

describe('readForeshadowingEntry', () => {
  it('读数据块里的四个字段', () => {
    const text = [
      'category: foreshadowing',
      'data:',
      '  name: 主角的身世',
      '  startChapter: "003"',
      '  endChapter: "012"',
      '  description: 一枚玉佩',
      ''
    ].join('\n')

    expect(readForeshadowingEntry(text)).toEqual({
      category: 'foreshadowing',
      name: '主角的身世',
      startChapter: '003',
      endChapter: '012',
      description: '一枚玉佩'
    })
  })

  it('顶层同名字段也认：手写的文件不必先补一层 data', () => {
    const text = [
      'category: foreshadowing',
      'name: 手写的伏笔',
      'startChapter: 第一章',
      'endChapter: 第三章',
      'description: 直接写在顶层',
      ''
    ].join('\n')

    expect(readForeshadowingEntry(text)).toEqual({
      category: 'foreshadowing',
      name: '手写的伏笔',
      startChapter: '第一章',
      endChapter: '第三章',
      description: '直接写在顶层'
    })
  })

  it('没有内容、没有字段、读不成标量时都不丢内容', () => {
    expect(readForeshadowingEntry('')).toEqual(emptyForeshadowingMetadata())
    expect(readForeshadowingEntry('# 只是笔记\n')).toEqual(emptyForeshadowingMetadata())

    // 没配对的引号仍然按原文收下：那一段仍然是用户写的东西
    expect(readForeshadowingEntry('data:\n  name: "没配对\n').name).toBe('"没配对')
  })

  it('类别决定它是不是伏笔，与文件在哪个目录无关', () => {
    expect(isForeshadowingDocument(METADATA)).toBe(true)
    expect(isForeshadowingDocument({ ...METADATA, category: 'gallery' })).toBe(false)
    expect(isForeshadowingDocument(emptyForeshadowingMetadata())).toBe(false)
  })
})

describe('formatForeshadowingEntry', () => {
  it('按固定顺序写四个字段，值一律加引号，整份文件就是这些行', () => {
    expect(formatForeshadowingEntry(METADATA)).toBe(
      [
        'category: "foreshadowing"',
        'data:',
        '  name: "主角的身世"',
        '  startChapter: "003"',
        '  endChapter: "012"',
        '  description: "第一章埋下的玉佩，到第十二章才解释清楚。"',
        ''
      ].join('\n')
    )
  })

  it('空字段不写出来：没有值不等于值是空串', () => {
    expect(formatForeshadowingEntry(emptyForeshadowingMetadata())).toBe(
      ['category: ""', 'data:', ''].join('\n')
    )
  })

  it('写出来的东西能原样读回来', () => {
    expect(readForeshadowingEntry(formatForeshadowingEntry(METADATA))).toEqual(METADATA)
  })
})

describe('composeForeshadowingEntry', () => {
  it('建出来就带着类别与一个空的数据块', () => {
    expect(composeForeshadowingEntry()).toBe(
      formatForeshadowingEntry({
        ...emptyForeshadowingMetadata(),
        category: FORESHADOWING_CATEGORY
      })
    )

    const metadata = readForeshadowingEntry(composeForeshadowingEntry())
    expect(metadata).toEqual({ ...emptyForeshadowingMetadata(), category: FORESHADOWING_CATEGORY })
    expect(isForeshadowingDocument(metadata)).toBe(true)
  })
})

describe('isForeshadowingPath', () => {
  it('只认 .yml 与 .yaml', () => {
    expect(isForeshadowingPath('/p/foreshadowing/a.yml')).toBe(true)
    expect(isForeshadowingPath('/p/foreshadowing/a.YAML')).toBe(true)
    expect(isForeshadowingPath('/p/foreshadowing/a.md')).toBe(false)
    expect(isForeshadowingPath('/p/foreshadowing/a.txt')).toBe(false)
    expect(isForeshadowingPath('/p/foreshadowing/a')).toBe(false)
  })

  it('默认扩展名是 .yml', () => {
    expect(DEFAULT_FORESHADOWING_EXTENSION).toBe('.yml')
  })
})

describe('foreshadowingEntryLabel', () => {
  it('优先用名称；名称为空时回落到文件名（去掉扩展名）', () => {
    expect(foreshadowingEntryLabel({ name: '主角的身世' }, 'foreshadowing_1.yml')).toBe(
      '主角的身世'
    )
    expect(foreshadowingEntryLabel({ name: '   ' }, 'foreshadowing_1.yml')).toBe('foreshadowing_1')
    expect(foreshadowingEntryLabel({ name: '' }, '没有扩展名')).toBe('没有扩展名')
  })
})
