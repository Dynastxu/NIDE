import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteProjectEntry,
  type RootsOptions
} from '../../../src/main/services/project-files.service'

/**
 * 删除的**写盘**部分。
 *
 * 这是宿主唯一不可撤销的动作，所以用例挑的都是「错了就找不回来」的地方：删错根
 * （整个项目没了）、顺着符号链接删到项目外面、以及「本来就不在」该不该算失败。
 * 与重命名那份一样，起真的临时目录、用真的文件与链接去撞它 —— 这些结论只有真的
 * 文件系统给得出来。
 */

let root = ''
/** 根**外面**的目录：用来证明边界拦得住 */
let outside = ''

const windows = process.platform === 'win32'

function options(overrides: Partial<RootsOptions> = {}): RootsOptions {
  return {
    roots: [root],
    caseInsensitive: windows,
    ...overrides
  }
}

async function writeFile(relativePath: string, content = relativePath): Promise<string> {
  const full = path.join(root, relativePath)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content, 'utf-8')
  return full
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
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nide-delete-')))
  root = path.join(base, 'project')
  outside = path.join(base, 'outside')
  await fs.mkdir(root)
  await fs.mkdir(outside)
})

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true })
})

describe('deleteProjectEntry：删文件', () => {
  it('删掉一个文件，别的都还在', async () => {
    const victim = await writeFile('第一章.md', '正文')
    const keep = await writeFile('第二章.md', '正文')

    const result = await deleteProjectEntry({ targetPath: victim }, options())

    expect(result).toEqual({ ok: true, path: victim, kind: 'file' })
    expect(await exists(victim)).toBe(false)
    expect(await exists(keep)).toBe(true)
  })

  it('删一个目录，里面的东西一起走', async () => {
    await writeFile('卷一/第一章.md')
    await writeFile('卷一/第二章.md', '正文')
    const other = await writeFile('卷二/第一章.md')

    const result = await deleteProjectEntry({ targetPath: path.join(root, '卷一') }, options())

    expect(result.ok && result.kind).toBe('directory')
    expect(await exists(path.join(root, '卷一'))).toBe(false)
    expect(await exists(other)).toBe(true)
  })

  it('空目录也删得掉 —— 这正是「空文件夹展不开」之后用户会走的那条路', async () => {
    const empty = path.join(root, '空')
    await fs.mkdir(empty)

    const result = await deleteProjectEntry({ targetPath: empty }, options())

    expect(result.ok).toBe(true)
    expect(await exists(empty)).toBe(false)
  })
})

describe('deleteProjectEntry：本来就不在', () => {
  it('目标已经不存在时算成功（用户想要的状态已经成立），kind 是 null', async () => {
    const missing = path.join(root, '不存在.md')

    const result = await deleteProjectEntry({ targetPath: missing }, options())

    expect(result).toEqual({ ok: true, path: missing, kind: null })
  })

  it('先删一次、再删一次，第二次仍然是成功', async () => {
    const victim = await writeFile('a.md')

    expect((await deleteProjectEntry({ targetPath: victim }, options())).ok).toBe(true)
    expect((await deleteProjectEntry({ targetPath: victim }, options())).ok).toBe(true)
  })
})

describe('deleteProjectEntry：项目根不能删', () => {
  it('根自己一律拒绝', async () => {
    await writeFile('第一章.md')

    const result = await deleteProjectEntry({ targetPath: root }, options())

    expect(result).toEqual({ ok: false, reason: 'is-project-root' })
    // 这一条就是这个用例存在的理由：整个项目还在
    expect(await exists(path.join(root, '第一章.md'))).toBe(true)
  })

  it('根的大小写变了也拒绝（Windows 上那是同一个目录）', async () => {
    if (!windows) return

    const result = await deleteProjectEntry(
      { targetPath: root.toUpperCase() },
      options({ caseInsensitive: true })
    )

    expect(result).toEqual({ ok: false, reason: 'is-project-root' })
    expect(await exists(root)).toBe(true)
  })

  it('多个根时，每一个根都不能删', async () => {
    const second = path.join(path.dirname(root), 'project2')
    await fs.mkdir(second)

    const result = await deleteProjectEntry(
      { targetPath: second },
      options({ roots: [root, second] })
    )

    expect(result).toEqual({ ok: false, reason: 'is-project-root' })
    expect(await exists(second)).toBe(true)
  })
})

describe('deleteProjectEntry：沙箱边界', () => {
  it('根外面的东西删不掉', async () => {
    const victim = path.join(outside, 'victim.md')
    await fs.writeFile(victim, '不该被删', 'utf-8')

    const result = await deleteProjectEntry({ targetPath: victim }, options())

    expect(result).toEqual({ ok: false, reason: 'unreadable' })
    expect(await exists(victim)).toBe(true)
  })

  it('前缀相同的兄弟目录不算根内，删不掉', async () => {
    const sibling = `${root}2`
    await fs.mkdir(sibling)
    const victim = path.join(sibling, 'victim.md')
    await fs.writeFile(victim, 'x', 'utf-8')

    const result = await deleteProjectEntry({ targetPath: victim }, options())

    expect(result.ok).toBe(false)
    expect(await exists(victim)).toBe(true)
  })

  it('相对路径一律拒绝 —— 它可以把删除引到根外面', async () => {
    await writeFile('a.md')

    const result = await deleteProjectEntry({ targetPath: '../outside/a.md' }, options())

    expect(result).toEqual({ ok: false, reason: 'unreadable' })
    expect(await exists(path.join(root, 'a.md'))).toBe(true)
  })

  it('要删的是符号链接时拒绝 —— 递归删除会顺着它走进根外面', async () => {
    const victim = path.join(outside, 'victim.md')
    await fs.writeFile(victim, '不该被删', 'utf-8')
    const link = path.join(root, '链接.md')
    await fs.symlink(victim, link)

    const result = await deleteProjectEntry({ targetPath: link }, options())

    expect(result).toEqual({ ok: false, reason: 'not-a-file' })
    // 链接本身与它的目标都要还在
    expect(await exists(link)).toBe(true)
    expect(await exists(victim)).toBe(true)
  })

  it('指向根外的**目录**链接同样拒绝，链接里面那些文件一个都没少', async () => {
    const inner = path.join(outside, 'inner')
    await fs.mkdir(inner)
    const victim = path.join(inner, 'a.md')
    await fs.writeFile(victim, '不该被删', 'utf-8')

    const link = path.join(root, '目录链接')
    await fs.symlink(inner, link, 'dir')

    const result = await deleteProjectEntry({ targetPath: link }, options())

    expect(result.ok).toBe(false)
    expect(await exists(victim)).toBe(true)
  })
})
