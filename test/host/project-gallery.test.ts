import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createProjectGallery,
  readProjectGalleries,
  type RootsOptions
} from '../../packages/host/src/services/project-files.ts'
import {
  DEFAULT_GALLERY_FIELDS,
  DEFAULT_CHARACTER_GALLERY_FIELDS,
  GALLERY_CATEGORY,
  parseGalleryConfig,
  serializeGalleryConfig
} from '../../packages/contracts/src/project/index.ts'

/**
 * 图鉴的**读盘**部分：新建一个图鉴（目录 + 字段表），以及读一个图鉴目录里的所有图鉴。
 *
 * 这一段只有真的文件系统给得出结论 —— 图鉴是**分区**的（内容目录下每个子目录一个，
 * 见 shared/project/gallery），而「读不出字段表时用默认字段」「`config.yml` 不算条目」
 * 这些结论都落在盘上。用例重点撞这几处，以及新建那一条的边界（不覆盖、不跑出项目、
 * 不跟着符号链接走）。
 */

/**
 * 图鉴字段名本身就是中文，直接写成标识符会让 IDE 的非 ASCII 名称检查报警。
 * 对象键用这里的 ASCII 常量（计算键），字段名仍是中文原文。
 */
const FIELD_NAME = '名称'
const FIELD_APPEARANCE = '外貌'

let root = ''
let outside = ''
const windows = process.platform === 'win32'

function options(overrides: Partial<RootsOptions> = {}): RootsOptions {
  return { roots: [root], caseInsensitive: windows, ...overrides }
}

/** 项目根 / 图鉴内容目录 */
function galleryRoot(): string {
  return path.join(root, 'gallery')
}

async function writeFile(relativePath: string, content: string): Promise<string> {
  const full = path.join(root, relativePath)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content, 'utf-8')
  return full
}

/** 一个图鉴条目文件的内容 */
function entryText(values: Record<string, string>): string {
  const lines = [`category: ${GALLERY_CATEGORY}`, 'data:']
  for (const [field, value] of Object.entries(values)) lines.push(`  ${field}: "${value}"`)

  return `${lines.join('\n')}\n`
}

beforeEach(async () => {
  // realpath：macOS 的 /var 是 /private/var 的链接，不解析的话范围校验会判错
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nide-gallery-')))
  root = path.join(base, 'project')
  outside = path.join(base, 'outside')

  await fs.mkdir(galleryRoot(), { recursive: true })
  await fs.mkdir(outside, { recursive: true })
})

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true })
})

describe('createProjectGallery', () => {
  it('建出一个目录，并写下带默认字段的 config.yml', async () => {
    const result = await createProjectGallery(
      { targetPath: galleryRoot(), name: '角色' },
      options()
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.path).toBe(path.join(galleryRoot(), '角色'))
    expect(result.configPath).toBe(path.join(galleryRoot(), '角色', 'config.yml'))

    const parsed = parseGalleryConfig(await fs.readFile(result.configPath, 'utf-8'))
    expect(parsed?.fields).toEqual([...DEFAULT_GALLERY_FIELDS])
  })

  it('目录已经存在时**不覆盖**：里面那份字段表一个字都不动', async () => {
    const custom = serializeGalleryConfig({ fields: ['名称', '我自己的字段'] })
    await writeFile('gallery/角色/config.yml', custom)

    const result = await createProjectGallery(
      { targetPath: galleryRoot(), name: '角色' },
      options()
    )

    expect(result).toEqual({ ok: false, reason: 'already-exists' })
    expect(await fs.readFile(path.join(galleryRoot(), '角色', 'config.yml'), 'utf-8')).toBe(custom)
  })

  it('名字非法时不碰盘', async () => {
    for (const name of ['', '   ', '卷一/角色', '..', '.隐藏']) {
      const result = await createProjectGallery({ targetPath: galleryRoot(), name }, options())
      expect(result).toEqual({ ok: false, reason: 'invalid-name' })
    }
  })

  it('落点跑到项目之外时拒绝', async () => {
    const result = await createProjectGallery({ targetPath: outside, name: '角色' }, options())

    expect(result).toEqual({ ok: false, reason: 'unreadable' })
    expect(await exists(path.join(outside, '角色'))).toBe(false)
  })

  it('落点不是一个目录（是个文件）时拒绝', async () => {
    const file = await writeFile('gallery/占位.txt', '')

    const result = await createProjectGallery({ targetPath: file, name: '角色' }, options())

    expect(result).toEqual({ ok: false, reason: 'not-a-directory' })
  })

  it('落点是符号链接时拒绝 —— 它能把「根内新建」变成「根外新建」', async () => {
    const link = path.join(root, '链接')
    await fs.symlink(outside, link, 'dir')

    const result = await createProjectGallery({ targetPath: link, name: '角色' }, options())

    expect(result).toEqual({ ok: false, reason: 'not-a-directory' })
    expect(await exists(path.join(outside, '角色'))).toBe(false)
  })
})

describe('readProjectGalleries', () => {
  it('内容目录下每个子目录一个图鉴，各自带字段表与条目', async () => {
    await writeFile('gallery/角色/config.yml', serializeGalleryConfig({ fields: ['名称', '外貌'] }))
    await writeFile(
      'gallery/角色/主角.yml',
      entryText({ [FIELD_NAME]: '主角', [FIELD_APPEARANCE]: '黑发' })
    )
    // 只有文件名、没有名字字段的条目：列表回落到文件名
    await writeFile('gallery/角色/配角.yml', entryText({ [FIELD_APPEARANCE]: '高个' }))

    const result = await readProjectGalleries(galleryRoot(), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.galleries.map((gallery) => gallery.name)).toEqual(['角色'])

    const gallery = result.galleries[0]
    expect(gallery?.fields).toEqual(['名称', '外貌'])
    expect(gallery?.configPath).toBe(path.join(galleryRoot(), '角色', 'config.yml'))
    // 断言按文件名取，不比整体顺序：中文名的排序依 locale 而定（见下面那条用例）
    expect(new Map(gallery?.entries.map((entry) => [entry.name, entry.label]))).toEqual(
      new Map([
        ['主角.yml', '主角'],
        ['配角.yml', '配角']
      ])
    )
  })

  it('条目按文件名排序（数字按数值大小）', async () => {
    await writeFile('gallery/角色/a.yml', entryText({ [FIELD_NAME]: 'A' }))
    await writeFile('gallery/角色/b.yml', entryText({ [FIELD_NAME]: 'B' }))
    await writeFile('gallery/角色/10.yml', entryText({ [FIELD_NAME]: '十' }))
    await writeFile('gallery/角色/2.yml', entryText({ [FIELD_NAME]: '二' }))

    const result = await readProjectGalleries(galleryRoot(), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.galleries[0]?.entries.map((entry) => entry.name)).toEqual([
      '2.yml',
      '10.yml',
      'a.yml',
      'b.yml'
    ])
  })

  it('读不出 config.yml 的图鉴用默认字段，而不是报错或空表', async () => {
    // 一个由别的工具建出来的目录：没有字段表，但它仍然是一个图鉴
    await writeFile('gallery/地点/王城.yml', entryText({ [FIELD_NAME]: '王城' }))

    const result = await readProjectGalleries(galleryRoot(), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const gallery = result.galleries.find((item) => item.name === '地点')
    expect(gallery?.fields).toEqual([...DEFAULT_GALLERY_FIELDS])
    expect(gallery?.entries.map((entry) => entry.label)).toEqual(['王城'])
  })

  it('字段表写坏时同样回落到默认字段（那份坏文件仍然留在盘上）', async () => {
    await writeFile('gallery/角色/config.yml', 'name: 角色\n')

    const result = await readProjectGalleries(galleryRoot(), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const gallery = result.galleries[0]
    expect(gallery?.fields).toEqual([...DEFAULT_GALLERY_FIELDS])
    // 坏文件不该被宿主悄悄改掉：读盘这一层只回报结论
    expect(await fs.readFile(path.join(galleryRoot(), '角色', 'config.yml'), 'utf-8')).toBe(
      'name: 角色\n'
    )
  })

  it('config.yml 自己不是条目，非 yml 的文件也不进列表，散着的文件不算图鉴', async () => {
    await writeFile('gallery/角色/config.yml', serializeGalleryConfig({ fields: ['名称'] }))
    await writeFile('gallery/角色/主角.yml', entryText({ [FIELD_NAME]: '主角' }))
    await writeFile('gallery/角色/笔记.txt', '随笔')
    await writeFile('gallery/说明.md', '# 图鉴')

    const result = await readProjectGalleries(galleryRoot(), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.galleries.map((gallery) => gallery.name)).toEqual(['角色'])
    expect(result.galleries[0]?.entries.map((entry) => entry.name)).toEqual(['主角.yml'])
  })

  it('目录不存在时给带原因的结果，而不是抛异常', async () => {
    const result = await readProjectGalleries(path.join(root, 'nope'), options())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not-a-directory')
  })

  it('目录在项目之外时拒绝', async () => {
    const result = await readProjectGalleries(outside, options())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('outside-project')
  })

  it('条目很长时只读开头，正文大小不影响名字', async () => {
    const long = 'x'.repeat(256 * 1024)
    await writeFile(
      'gallery/角色/主角.yml',
      `${entryText({ [FIELD_NAME]: '主角' })}\n备注: ${long}\n`
    )

    const result = await readProjectGalleries(galleryRoot(), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.galleries[0]?.entries[0]?.label).toBe('主角')
  })
})

describe('默认的角色图鉴', () => {
  it('默认字段里有「名称」，章节表单的出场角色才有一个能对上的名字', () => {
    expect(DEFAULT_CHARACTER_GALLERY_FIELDS).toContain('名称')
  })
})

/** 路径存在吗。存在性判断在几个「没被建出来」的断言里反复用到 */
async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}
