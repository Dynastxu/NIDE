import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readProjectDir,
  readProjectFile,
  writeProjectFile,
  type RootsOptions
} from '../../packages/services/content/src/project-files.ts'
import {
  HOST_TEMP_FILE_PREFIX,
  MAX_TEXT_FILE_BYTES
} from '../../packages/contracts/src/project/index.ts'

/**
 * 保存（把正文写回一个已有文件）的**写盘**部分。
 *
 * 这是宿主唯一**覆盖已有内容**的动作，所以用例挑的都是「错了就毁掉一份稿子」的地方：
 * 顺着符号链接写到项目外面、把一个已经不存在的文件悄悄建回来、写到宿主读不懂的格式上、
 * 或者中途失败在用户的目录里留下半份内容或一个临时件。与新建 / 改名 / 删除那几份一样，
 * 起真的临时目录、用真的文件与链接去撞它 —— 这些结论只有真的文件系统给得出来。
 */

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

async function readFile(target: string): Promise<string> {
  return fs.readFile(target, 'utf-8')
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

/** 这一层里的条目名（用来查「有没有留下临时件」） */
async function namesIn(dirPath: string): Promise<string[]> {
  return (await fs.readdir(dirPath)).sort()
}

beforeEach(async () => {
  // realpath：macOS 的 /var 是 /private/var 的链接，不解析的话范围校验会判错
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nide-write-')))
  root = path.join(base, 'project')
  outside = path.join(base, 'outside')
  await fs.mkdir(root)
  await fs.mkdir(outside)
})

afterEach(async () => {
  // 用例都在同一个父目录下建东西，删父目录就够了
  await fs.rm(path.dirname(root), { recursive: true, force: true })
})

describe('writeProjectFile：正常的保存', () => {
  it('覆盖已有内容，读回来就是刚写下去的那一份', async () => {
    const target = await writeFile('第一章.md', '旧的正文')

    const result = await writeProjectFile({ filePath: target, content: '新的正文' }, options())

    expect(result).toEqual({ ok: true, path: target })
    expect(await readFile(target)).toBe('新的正文')

    // 走读取那一侧再确认一次：两边对「这个文件里是什么」必须一致
    const read = await readProjectFile(target, options())
    expect(read).toEqual({ ok: true, path: target, content: '新的正文' })
  })

  it('多字节内容按 UTF-8 原样落盘', async () => {
    const target = await writeFile('第一章.md', 'x')
    const content = '第一章\n\n「引号」——破折号，还有 emoji：✍️\n'

    await writeProjectFile({ filePath: target, content }, options())

    expect(await readFile(target)).toBe(content)
  })

  it('同样的内容再存一次也算成功（幂等，文件不动）', async () => {
    const target = await writeFile('第一章.md', '同一份')

    const first = await writeProjectFile({ filePath: target, content: '同一份' }, options())
    const second = await writeProjectFile({ filePath: target, content: '同一份' }, options())

    expect(first).toEqual({ ok: true, path: target })
    expect(second).toEqual({ ok: true, path: target })
    expect(await readFile(target)).toBe('同一份')
  })

  it('保存之后目录里不留临时件，别的文件一点没动', async () => {
    const target = await writeFile('第一章.md', '旧的')
    const neighbour = await writeFile('第二章.md', '别动我')

    await writeProjectFile({ filePath: target, content: '新的' }, options())

    expect(await namesIn(root)).toEqual(['第一章.md', '第二章.md'])
    expect(await readFile(neighbour)).toBe('别动我')
  })

  it('内容里的 CRLF 与末尾换行原样写回，不被改写', async () => {
    const target = await writeFile('第一章.md', 'x')
    const content = '第一行\r\n第二行\n\n'

    await writeProjectFile({ filePath: target, content }, options())

    expect(await readFile(target)).toBe(content)
  })

  it('写空内容是一次合法的保存（把文件清空是用户自己按的）', async () => {
    const target = await writeFile('第一章.md', '旧的')

    const result = await writeProjectFile({ filePath: target, content: '' }, options())

    expect(result).toEqual({ ok: true, path: target })
    expect(await readFile(target)).toBe('')
  })
})

describe('writeProjectFile：沙箱边界', () => {
  it('根外面的文件写不了，外面那份内容没变', async () => {
    const victim = path.join(outside, 'victim.md')
    await fs.writeFile(victim, '不该被写', 'utf-8')

    const result = await writeProjectFile({ filePath: victim, content: '被改了' }, options())

    expect(result).toEqual({ ok: false, reason: 'outside-project' })
    expect(await readFile(victim)).toBe('不该被写')
  })

  it('前缀相同的兄弟目录不算根内，写不了', async () => {
    const sibling = `${root}2`
    await fs.mkdir(sibling)
    const victim = path.join(sibling, 'victim.md')
    await fs.writeFile(victim, '不该被写', 'utf-8')

    const result = await writeProjectFile({ filePath: victim, content: '被改了' }, options())

    expect(result).toEqual({ ok: false, reason: 'outside-project' })
    expect(await readFile(victim)).toBe('不该被写')
  })

  it('相对路径与空路径一律拒绝', async () => {
    await writeFile('a.md')

    expect(await writeProjectFile({ filePath: 'a.md', content: 'x' }, options())).toEqual({
      ok: false,
      reason: 'invalid-path'
    })
    expect(await writeProjectFile({ filePath: '', content: 'x' }, options())).toEqual({
      ok: false,
      reason: 'invalid-path'
    })
  })

  it('正文不是字符串时拒绝，文件一点没动', async () => {
    const target = await writeFile('第一章.md', '旧的')

    const result = await writeProjectFile(
      { filePath: target, content: null as unknown as string },
      options()
    )

    expect(result).toEqual({ ok: false, reason: 'invalid-path' })
    expect(await readFile(target)).toBe('旧的')
  })
})

describe('writeProjectFile：目标本身', () => {
  it('目标已经不在了：报错，而**不**顺手把它建回来', async () => {
    const gone = path.join(root, '第一章.md')

    const result = await writeProjectFile({ filePath: gone, content: '新写的' }, options())

    expect(result).toEqual({ ok: false, reason: 'not-a-file' })
    expect(await exists(gone)).toBe(false)
  })

  it('目标是个目录时拒绝（那是「写到哪儿」搞错了，不是格式问题）', async () => {
    const dir = path.join(root, 'chapters')
    await fs.mkdir(dir)

    const result = await writeProjectFile({ filePath: dir, content: 'x' }, options())

    expect(result).toEqual({ ok: false, reason: 'not-a-file' })
    expect(await exists(dir)).toBe(true)
  })

  it('目标是符号链接时拒绝，链接指向的那份内容没被改', async () => {
    /**
     * 链接放在根内、指向根外：顺着它写下去，写的就是根外的那个文件 ——
     * 而「保存」本该只可能写用户自己项目里的东西。
     */
    const target = path.join(outside, 'target.md')
    await fs.writeFile(target, '根外的原文', 'utf-8')
    const link = path.join(root, 'link.md')
    await fs.symlink(target, link)

    const result = await writeProjectFile({ filePath: link, content: '被改了' }, options())

    expect(result).toEqual({ ok: false, reason: 'not-a-file' })
    expect(await readFile(target)).toBe('根外的原文')
  })

  it('宿主读不懂的格式不写回，内容没变', async () => {
    // `.png` 在编辑器里根本打不开，而覆盖式写入会把它毁掉
    const target = path.join(root, 'cover.png')
    await fs.writeFile(target, 'binary-ish', 'utf-8')

    const result = await writeProjectFile({ filePath: target, content: '文本' }, options())

    expect(result).toEqual({ ok: false, reason: 'not-text' })
    expect(await readFile(target)).toBe('binary-ish')
  })

  it('正文超出单文件上限时拒绝，内容没变', async () => {
    const target = await writeFile('第一章.md', '旧的')

    const result = await writeProjectFile(
      { filePath: target, content: 'a'.repeat(MAX_TEXT_FILE_BYTES + 1) },
      options()
    )

    expect(result).toEqual({ ok: false, reason: 'too-large' })
    expect(await readFile(target)).toBe('旧的')
  })
})

describe('宿主的临时件不进文件树', () => {
  it('保存用的临时件不入树，普通文件照常列出', async () => {
    await writeFile('第一章.md', '正文')
    // 命名沿用宿主自己的前缀，模拟「读目录正好撞上一次保存」那一瞬间
    await writeFile(`${HOST_TEMP_FILE_PREFIX}save-abc123`, '半份内容')

    const listing = await readProjectDir(root, options())

    expect(listing.ok).toBe(true)
    if (!listing.ok) return
    expect(listing.entries.map((entry) => entry.name)).toEqual(['第一章.md'])
  })

  it('按前缀判，不看「以点开头」：.gitignore 这类文件照常列出', async () => {
    await writeFile('.gitignore', 'notes.md')
    await writeFile('第一章.md', '正文')

    const listing = await readProjectDir(root, options())

    expect(listing.ok).toBe(true)
    if (!listing.ok) return
    // 排序由主进程按当前语言的比较器做，这里只关心「有没有它」，不押在顺序上
    expect(listing.entries.map((entry) => entry.name).sort()).toEqual(
      ['.gitignore', '第一章.md'].sort()
    )
  })
})
