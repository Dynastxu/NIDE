import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  renameProjectEntry,
  type RootsOptions
} from '../../../src/main/services/project-files.service'

/**
 * 重命名的**写盘**部分。
 *
 * 这一层没有自动化测试的替代品：名字校验（validateEntryName）是纯逻辑，可以单测，
 * 而「绝不覆盖」「不跟着链接走」「跑不出根」这三条只有在真的文件系统上才立得住。
 * 所以这里起一个真的临时目录当项目根，用真的文件与链接去撞它。
 *
 * 用例挑的都是**会静默毁掉用户稿子**的地方：覆盖同名文件、跟着符号链接改名、
 * 或者把名字改到项目外面去 —— 这些错了不会报错，只会在某一天发现稿子没了。
 */

/** 假的「项目根」：一个真的临时目录。每个用例一个，跑完就删 */
let root = ''
/** 根**外面**的目录：用来证明边界拦得住。与 root 平级，不以 root 为前缀 */
let outside = ''

const windows = process.platform === 'win32'

function options(overrides: Partial<RootsOptions> = {}): RootsOptions {
  return {
    roots: [root],
    // 与主进程一致：Windows 的路径不区分大小写
    caseInsensitive: windows,
    ...overrides
  }
}

/** 建一个文件，内容非空 —— 「被覆盖」才看得出来 */
async function writeFile(relativePath: string, content = relativePath): Promise<string> {
  const full = path.join(root, relativePath)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content, 'utf-8')
  return full
}

async function readFile(relativePath: string): Promise<string> {
  return fs.readFile(path.join(root, relativePath), 'utf-8')
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

beforeEach(async () => {
  // realpath：macOS 的 /var 是 /private/var 的链接，不解析的话范围校验会判错
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nide-rename-')))
  root = path.join(base, 'project')
  outside = path.join(base, 'outside')
  await fs.mkdir(root)
  await fs.mkdir(outside)
})

afterEach(async () => {
  // 用例都在同一个父目录下建东西，删父目录就够了
  await fs.rm(path.dirname(root), { recursive: true, force: true })
})

describe('renameProjectEntry：正常的改名', () => {
  it('文件改名之后旧名字没了、内容原样', async () => {
    const before = await writeFile('第一章.md', '正文')

    const result = await renameProjectEntry({ targetPath: before, name: '第二章.md' }, options())

    expect(result).toEqual({
      ok: true,
      path: path.join(root, '第二章.md'),
      previousPath: before,
      kind: 'file'
    })
    expect(await readFile('第二章.md')).toBe('正文')
    expect(await exists(path.join(root, '第一章.md'))).toBe(false)
  })

  it('目录改名把里面的东西一起带走', async () => {
    const nested = await writeFile('卷一/第一章.md', '正文')

    const result = await renameProjectEntry(
      { targetPath: path.join(root, '卷一'), name: '卷二' },
      options()
    )

    expect(result.ok && result.kind).toBe('directory')
    expect(await readFile('卷二/第一章.md')).toBe('正文')
    expect(await exists(path.join(root, '卷一'))).toBe(false)
    expect(nested).toContain('卷一')
  })

  it('名字前后的空白被 trim 掉，落盘的就是 trim 之后那个', async () => {
    const before = await writeFile('a.md')

    const result = await renameProjectEntry({ targetPath: before, name: '  b.md  ' }, options())

    expect(result.ok && result.path).toBe(path.join(root, 'b.md'))
    expect(await exists(path.join(root, 'b.md'))).toBe(true)
  })

  it('同一个名字是空操作，且**不碰盘**', async () => {
    const before = await writeFile('a.md', '正文')

    const result = await renameProjectEntry({ targetPath: before, name: 'a.md' }, options())

    expect(result).toEqual({
      ok: true,
      path: before,
      previousPath: before,
      kind: 'file'
    })
    expect(await readFile('a.md')).toBe('正文')
  })

  it('只换扩展名（.txt -> .md）是允许的，正文不动', async () => {
    const before = await writeFile('notes.txt', '正文')

    const result = await renameProjectEntry({ targetPath: before, name: 'notes.md' }, options())

    expect(result.ok && result.path).toBe(path.join(root, 'notes.md'))
    expect(await readFile('notes.md')).toBe('正文')
  })

  it('改成没有扩展名的名字也是允许的 —— 名字按原样落盘，不替用户补拓展名', async () => {
    const before = await writeFile('notes.md', '正文')

    const result = await renameProjectEntry({ targetPath: before, name: '笔记' }, options())

    expect(result.ok && result.path).toBe(path.join(root, '笔记'))
    expect(await exists(path.join(root, '笔记'))).toBe(true)
    // 不该出现「笔记.md」这种宿主自己补出来的东西
    expect(await exists(path.join(root, '笔记.md'))).toBe(false)
  })
})

describe('renameProjectEntry：绝不覆盖', () => {
  it('落点已经有同名文件时拒绝，且两边的内容都不动', async () => {
    const before = await writeFile('a.md', '甲')
    const occupied = await writeFile('b.md', '乙')

    const result = await renameProjectEntry({ targetPath: before, name: 'b.md' }, options())

    expect(result).toEqual({ ok: false, reason: 'already-exists' })
    // 这一条就是这个用例存在的理由：覆盖了的话「乙」就永远找不回来了
    expect(await readFile('b.md')).toBe('乙')
    expect(await readFile('a.md')).toBe('甲')
    expect(occupied).toBe(path.join(root, 'b.md'))
  })

  it('被一个同名**目录**占着时同样拒绝', async () => {
    const before = await writeFile('a.md')
    await fs.mkdir(path.join(root, 'b.md'))

    const result = await renameProjectEntry({ targetPath: before, name: 'b.md' }, options())

    expect(result).toEqual({ ok: false, reason: 'already-exists' })
    expect(await exists(path.join(root, 'a.md'))).toBe(true)
  })

  it('被一个同名符号链接占着时也拒绝 —— 链接也不覆盖', async () => {
    const before = await writeFile('a.md')
    await fs.symlink(path.join(outside, 'target.md'), path.join(root, 'b.md'))

    const result = await renameProjectEntry({ targetPath: before, name: 'b.md' }, options())

    expect(result).toEqual({ ok: false, reason: 'already-exists' })
    expect(await exists(path.join(root, 'a.md'))).toBe(true)
  })
})

describe('renameProjectEntry：名字校验与新建共用同一套', () => {
  it.each([
    ['空名字', ''],
    ['纯空白', '   '],
    ['带路径分隔符', 'a/b'],
    ['想跳到上一层', '../escape.md'],
    ['以点开头', '.hidden.md'],
    ['以点结尾', 'a.'],
    ['Windows 非法字符', 'a:b.md']
  ])('%s 被拒', async (_label, name) => {
    const before = await writeFile('a.md')

    const result = await renameProjectEntry({ targetPath: before, name }, options())

    expect(result).toEqual({ ok: false, reason: 'invalid-name' })
    expect(await exists(path.join(root, 'a.md'))).toBe(true)
  })

  it('校验在碰盘之前：目标不存在时也先报名字问题', async () => {
    const result = await renameProjectEntry(
      { targetPath: path.join(root, '不存在.md'), name: '..' },
      options()
    )

    expect(result).toEqual({ ok: false, reason: 'invalid-name' })
  })
})

describe('renameProjectEntry：沙箱边界', () => {
  it('根外面的条目改不了名', async () => {
    const victim = path.join(outside, 'victim.md')
    await fs.writeFile(victim, '不该被改名', 'utf-8')

    const result = await renameProjectEntry({ targetPath: victim, name: 'renamed.md' }, options())

    expect(result).toEqual({ ok: false, reason: 'unreadable' })
    expect(await exists(victim)).toBe(true)
    expect(await exists(path.join(outside, 'renamed.md'))).toBe(false)
  })

  it('前缀相同的兄弟目录不算根内，改不了', async () => {
    const sibling = `${root}2`
    await fs.mkdir(sibling)
    const victim = path.join(sibling, 'victim.md')
    await fs.writeFile(victim, 'x', 'utf-8')

    const result = await renameProjectEntry({ targetPath: victim, name: 'y.md' }, options())

    expect(result.ok).toBe(false)
    expect(await exists(victim)).toBe(true)
  })

  it('相对路径一律拒绝', async () => {
    await writeFile('a.md')

    const result = await renameProjectEntry({ targetPath: 'a.md', name: 'b.md' }, options())

    expect(result).toEqual({ ok: false, reason: 'unreadable' })
  })

  it('要改的是一个符号链接时拒绝 —— 它可以把改名引到根外面去', async () => {
    const victim = path.join(outside, 'victim.md')
    await fs.writeFile(victim, 'x', 'utf-8')
    const link = path.join(root, '链接.md')
    await fs.symlink(victim, link)

    const result = await renameProjectEntry({ targetPath: link, name: '改过的.md' }, options())

    expect(result).toEqual({ ok: false, reason: 'not-a-file' })
    // 链接与其目标都还在，目标的名字也没变
    expect(await exists(link)).toBe(true)
    expect(await exists(victim)).toBe(true)
  })

  it('改名不会把新名字落到别的目录去', async () => {
    // `../` 已经在名字校验那一关被挡掉，这里再从结果上确认一次
    const before = await writeFile('a.md')

    await renameProjectEntry({ targetPath: before, name: '../逃脱.md' }, options())

    expect(await exists(path.join(root, '..', '逃脱.md'))).toBe(false)
  })
})

describe('renameProjectEntry：目标没了', () => {
  it('条目已经被删掉时给「不在了」，而不是抛异常', async () => {
    const result = await renameProjectEntry(
      { targetPath: path.join(root, '不存在.md'), name: 'b.md' },
      options()
    )

    expect(result).toEqual({ ok: false, reason: 'not-a-file' })
  })
})

describe('renameProjectEntry：只改大小写', () => {
  it('大小写不敏感时，改大小写是一次真实的改名（Windows / macOS 的默认卷）', async () => {
    const before = await writeFile('Chapter.md', '正文')

    const result = await renameProjectEntry(
      { targetPath: before, name: 'CHAPTER.md' },
      options({ caseInsensitive: true })
    )

    expect(result.ok).toBe(true)
    expect(await readFile('CHAPTER.md')).toBe('正文')
    /*
     * 目录里只该剩一个条目 —— 这一条才是这个用例的重点：落点按不敏感语义就是
     * **它自己**，两段式改名（经一个中间名）没有在磁盘上留下第二个文件，
     * 也没有留下那个 `.nide-rename-…` 的中间名。
     */
    expect(await fs.readdir(root)).toEqual(['CHAPTER.md'])
  })

  it('改大小写不会留下第二个条目，也不会留下中间名（换个方向再来一次）', async () => {
    const before = await writeFile('notes.md', '正文')

    const result = await renameProjectEntry(
      { targetPath: before, name: 'NOTES.MD' },
      options({ caseInsensitive: true })
    )

    expect(result.ok).toBe(true)
    expect(await readFile('NOTES.MD')).toBe('正文')
    // 扩展名也一起变大写了：落点始终是同一个条目，中间名不该留下
    expect(await fs.readdir(root)).toEqual(['NOTES.MD'])
  })

  it('落点被**另一个**字面同名的条目占着时仍然拒绝（大小写不敏感也一样）', async () => {
    /*
     * 这一条守的是「绝不覆盖」在大小写不敏感平台上的那半边：这一层里**字面**存在
     * 两个只差大小写的名字（NTFS 允许），而落点 `part.md` 字面命中了第二个 ——
     * 必须拒绝，而不是把第一个改过去把它覆盖掉。
     *
     * 第二个条目只能靠 `fs.link` 造：`fs.writeFile('part.md')` 在不敏感的文件系统上
     * 命中的就是 `Part.md`，Node 会**打开并截断**它 —— 路径 API 造不出「另一个字面
     * 同名的条目」。link 按字面名建条目，名字已被占用时报 EEXIST 而不是覆盖。
     *
     * 两个名字指的是同一份内容（硬链接），所以这里断言的是**结构**：
     * 两个条目都在、改名被拒、拒绝之后两个都还在。
     */
    if (!windows) return

    const before = await writeFile('Part.md', '甲')

    try {
      await fs.link(before, path.join(root, 'part.md'))
    } catch {
      // 这个卷上造不出大小写变体（例如按目录开着的 case sensitivity），跳过
      return
    }

    expect(await fs.readdir(root)).toHaveLength(2)

    const result = await renameProjectEntry(
      { targetPath: before, name: 'part.md' },
      options({ caseInsensitive: true })
    )

    expect(result).toEqual({ ok: false, reason: 'already-exists' })
    expect((await fs.readdir(root)).sort()).toEqual(['Part.md', 'part.md'])
  })
})
