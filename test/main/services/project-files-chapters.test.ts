import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createProjectEntry,
  readProjectChapters,
  type RootsOptions
} from '../../../src/main/services/project-files.service'

/**
 * 章节列表与「带初始内容的新建」的**读盘**部分。
 *
 * 这一段只有真的文件系统给得出结论：章节号写在文件开头的 frontmatter 里（`data.index`，
 * 见 shared/project/chapters），而这一步要**只读开头**（不把整章正文读进来）。用例因此
 * 重点撞这几个地方：读得出号、读不出号的仍然列出来、序章的 0 与「还没编号」分得开、
 * 非 Markdown 不参与、以及新建时内容与文件是同一次落盘的。
 */

let root = ''
const windows = process.platform === 'win32'

/** 一份章节 frontmatter。用例只关心编号，其余字段写不写都不影响这一步 */
function frontmatter(index: number | string): string {
  return `---\ncategory: chapter\ndata:\n  index: "${index}"\n---\n`
}

function options(overrides: Partial<RootsOptions> = {}): RootsOptions {
  return { roots: [root], caseInsensitive: windows, ...overrides }
}

async function writeFile(relativePath: string, content: string): Promise<string> {
  const full = path.join(root, relativePath)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content, 'utf-8')
  return full
}

beforeEach(async () => {
  // realpath：macOS 的 /var 是 /private/var 的链接，不解析的话范围校验会判错
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nide-chapters-')))
  root = path.join(base, 'project')
  await fs.mkdir(path.join(root, 'chapters'), { recursive: true })
})

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true })
})

describe('readProjectChapters', () => {
  it('读出每一章的编号与一级标题，顺序与目录排序一致', async () => {
    await writeFile('chapters/chapter_1.md', `${frontmatter(1)}\n# Chapter 1\n\n正文`)
    await writeFile('chapters/chapter_2.md', `${frontmatter(2)}\n# 决战前夜\n\n正文`)

    const result = await readProjectChapters(path.join(root, 'chapters'), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.chapters.map((file) => [file.name, file.chapter, file.heading])).toEqual([
      ['chapter_1.md', 1, 'Chapter 1'],
      ['chapter_2.md', 2, '决战前夜']
    ])
  })

  it('序章的 0 与「还没编号」分得开', async () => {
    await writeFile('chapters/序章.md', `${frontmatter(0)}\n# 序章\n`)
    await writeFile('chapters/手写的.md', '# 还没编号\n')

    const result = await readProjectChapters(path.join(root, 'chapters'), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const byName = new Map(result.chapters.map((file) => [file.name, file.chapter]))

    expect(byName.get('序章.md')).toBe(0)
    expect(byName.get('手写的.md')).toBeNull()
  })

  it('没有 frontmatter 的 Markdown 仍然列出来：编号为 null，标题照读', async () => {
    await writeFile('chapters/手写的.md', '# 随便写的一篇\n')

    const result = await readProjectChapters(path.join(root, 'chapters'), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.chapters).toHaveLength(1)
    expect(result.chapters[0]?.chapter).toBeNull()
    expect(result.chapters[0]?.heading).toBe('随便写的一篇')
  })

  it('有编号但没有一级标题时标题为 null（界面回落到文件名）', async () => {
    await writeFile('chapters/chapter_4.md', `${frontmatter(4)}\n只有正文`)

    const result = await readProjectChapters(path.join(root, 'chapters'), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.chapters[0]?.chapter).toBe(4)
    expect(result.chapters[0]?.heading).toBeNull()
  })

  it('旧写法（顶层的 chapter 键）读不出编号：宿主只认新结构', async () => {
    await writeFile('chapters/chapter_5.md', '---\nchapter: 005\n---\n\n# 旧文件\n')

    const result = await readProjectChapters(path.join(root, 'chapters'), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.chapters[0]?.chapter).toBeNull()
    // 标题照读：拿不到编号不影响这一篇被列出来
    expect(result.chapters[0]?.heading).toBe('旧文件')
  })

  it('非 Markdown 不参与章节列表', async () => {
    await writeFile('chapters/chapter_1.md', frontmatter(1))
    await writeFile('chapters/notes.txt', '随笔')

    const result = await readProjectChapters(path.join(root, 'chapters'), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.chapters.map((file) => file.name)).toEqual(['chapter_1.md'])
  })

  it('目录不存在时给带原因的结果，而不是抛异常', async () => {
    const result = await readProjectChapters(path.join(root, 'nope'), options())

    expect(result.ok).toBe(false)
    if (result.ok) return
    // 与读目录同一套归类：ENOENT 是「那儿不是一个目录」（见 classifyReadError）
    expect(result.reason).toBe('not-a-directory')
  })

  it('目录在项目之外时拒绝', async () => {
    const result = await readProjectChapters(path.dirname(root), options())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('outside-project')
  })

  it('文件很长时只读开头，正文大小不影响结果', async () => {
    // 前面是正常的 frontmatter，后面塞一大段正文（远超扫描上限）
    const body = 'x'.repeat(256 * 1024)
    await writeFile('chapters/chapter_9.md', `${frontmatter(9)}\n${body}`)

    const result = await readProjectChapters(path.join(root, 'chapters'), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.chapters[0]?.chapter).toBe(9)
  })

  it('元数据写满一章的上限时编号照样读得出来', async () => {
    /**
     * frontmatter 现在不止一个编号（还有细纲、角色、备注、概述），扫描上限也跟着放宽
     * 了一档。这条用例钉住的是「上限够不够」：写满一份长元数据之后，编号不能被截掉。
     */
    const long = '很长的元数据'.repeat(200)
    const text = [
      '---',
      'category: chapter',
      'data:',
      '  index: "011"',
      `  outline: ${long}`,
      '  characters:',
      '    - 主角',
      `  notes: ${long}`,
      `  summary: ${long}`,
      '---',
      '',
      '# 元数据很长的一章',
      ''
    ].join('\n')

    await writeFile('chapters/chapter_11.md', text)

    const result = await readProjectChapters(path.join(root, 'chapters'), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.chapters[0]?.chapter).toBe(11)
    expect(result.chapters[0]?.heading).toBe('元数据很长的一章')
  })
})

describe('带初始内容的新建', () => {
  it('文件与内容在同一次调用里落盘', async () => {
    const chaptersDir = path.join(root, 'chapters')
    const content = `${frontmatter(1)}\n`

    const result = await createProjectEntry(
      { kind: 'file', targetPath: chaptersDir, name: 'chapter_1.md', content },
      options()
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    // 落点报的是它自己，读回来就是写进去的那份内容
    expect(await fs.readFile(result.path, 'utf-8')).toBe(content)
  })

  it('不给内容时与以前一样是空文件', async () => {
    const result = await createProjectEntry(
      { kind: 'file', targetPath: path.join(root, 'chapters'), name: 'empty.md' },
      options()
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(await fs.readFile(result.path, 'utf-8')).toBe('')
  })

  it('给目录传内容被拒绝，而不是悄悄建一个空目录', async () => {
    const result = await createProjectEntry(
      {
        kind: 'directory',
        targetPath: path.join(root, 'chapters'),
        name: 'volume-1',
        content: '不该出现在这里'
      },
      options()
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not-a-directory')
  })

  it('同名文件已存在时仍然不覆盖', async () => {
    const chaptersDir = path.join(root, 'chapters')
    await writeFile('chapters/chapter_1.md', '原稿')

    const result = await createProjectEntry(
      { kind: 'file', targetPath: chaptersDir, name: 'chapter_1.md', content: '新稿' },
      options()
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('already-exists')
    expect(await fs.readFile(path.join(chaptersDir, 'chapter_1.md'), 'utf-8')).toBe('原稿')
  })
})
