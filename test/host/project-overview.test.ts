import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkProjectOverviewDocument,
  readProjectOverview,
  type RootsOptions
} from '../../packages/services/content/src/project-files.ts'
import {
  loadProjectConfig,
  projectConfigPath,
  remapOverviewRole,
  updateProjectConfig
} from '../../packages/services/config/src/project-config.ts'
import { parseProjectConfig } from '../../packages/contracts/src/project/index.ts'

/**
 * 概述的**读盘**部分：读目录里的普通 Markdown、确认某份文档能不能被标记，以及改名
 * 之后项目配置里的标记跟着走。
 *
 * 概述里全是普通文件；标记只是 `.nide/config.yml` 的两个可选文件名（见
 * shared/project/overview）。用例重点撞：
 *
 * - 目录里只列**直接放着的 Markdown**，非 Markdown 与子目录不混进来；
 * - 标记只接受概述目录里真实存在的 Markdown；
 * - 被标记的文件改名时配置跟着换，没标记的普通文件改名不碰配置。
 */

let root = ''
let outside = ''
const windows = process.platform === 'win32'

function options(overrides: Partial<RootsOptions> = {}): RootsOptions {
  return { roots: [root], caseInsensitive: windows, ...overrides }
}

/** 项目根 / 概述内容目录 */
function overviewRoot(): string {
  return path.join(root, 'overview')
}

async function writeFile(relativePath: string, content: string): Promise<string> {
  const full = path.join(root, relativePath)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content, 'utf-8')
  return full
}

async function read(target: string): Promise<string> {
  return fs.readFile(target, 'utf-8')
}

async function readProjectConfig(): Promise<ReturnType<typeof parseProjectConfig>> {
  return parseProjectConfig(await read(projectConfigPath(root)))
}

/** 建好项目配置，并把两份文件标记成大纲 / 写作风格 */
async function markRoles(outline = 'outline.md', style = 'style.md'): Promise<void> {
  await loadProjectConfig(root)
  const result = await updateProjectConfig(root, { overview: { outline, style } })
  expect(result.ok).toBe(true)
}

beforeEach(async () => {
  // realpath：macOS 的 /var 是 /private/var 的链接，不解析的话范围校验会判错
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nide-overview-')))
  root = path.join(base, 'project')
  outside = path.join(base, 'outside')

  await fs.mkdir(overviewRoot(), { recursive: true })
  await fs.mkdir(outside, { recursive: true })
})

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true })
})

describe('readProjectOverview', () => {
  it('只列直接放在概述目录里的 Markdown，子目录与非 Markdown 不混进来', async () => {
    await writeFile('overview/大纲.md', '# 大纲\n')
    await writeFile('overview/世界观.md', '# 世界观\n')
    await writeFile('overview/笔记.txt', '随笔')
    await writeFile('overview/子目录/深层.md', '# 深层\n')

    const result = await readProjectOverview(overviewRoot(), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(new Set(result.documents.map((document) => document.name))).toEqual(
      new Set(['大纲.md', '世界观.md'])
    )
  })

  it('目录不存在时给带原因的结果，而不是抛异常', async () => {
    const result = await readProjectOverview(path.join(root, 'nope'), options())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not-a-directory')
  })

  it('目录在项目之外时拒绝', async () => {
    const result = await readProjectOverview(outside, options())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('outside-project')
  })
})

describe('checkProjectOverviewDocument', () => {
  it('概述目录里真实存在的 Markdown 才返回 ok', async () => {
    await writeFile('overview/主线.md', '# 主线\n')
    await writeFile('overview/笔记.txt', '随笔')
    await fs.mkdir(path.join(overviewRoot(), '目录.md'))

    expect(await checkProjectOverviewDocument(overviewRoot(), '主线.md', options())).toBe('ok')
    expect(await checkProjectOverviewDocument(overviewRoot(), '不存在.md', options())).toBe(
      'unknown-file'
    )
    expect(await checkProjectOverviewDocument(overviewRoot(), '笔记.txt', options())).toBe(
      'unknown-file'
    )
    expect(await checkProjectOverviewDocument(overviewRoot(), '目录.md', options())).toBe(
      'unknown-file'
    )
    expect(await checkProjectOverviewDocument(overviewRoot(), '../主线.md', options())).toBe(
      'unknown-file'
    )
  })

  it('概述目录本身在允许的根之外时拒绝', async () => {
    await writeFile('outside/主线.md', '# 主线\n')

    expect(await checkProjectOverviewDocument(outside, '主线.md', options())).toBe('unreadable')
  })
})

describe('remapOverviewRole', () => {
  it('大纲改名之后，config.yml 里的 overview.outline 跟着换', async () => {
    await markRoles()
    await writeFile('overview/outline.md', '# 大纲\n')
    await writeFile('overview/style.md', '# 风格\n')

    const previousPath = path.join(overviewRoot(), 'outline.md')
    const nextPath = path.join(overviewRoot(), '主线.md')
    await fs.rename(previousPath, nextPath)

    expect(await remapOverviewRole(root, previousPath, nextPath)).toBe(true)
    expect((await readProjectConfig())?.overview).toEqual({
      path: 'overview',
      outline: '主线.md',
      style: 'style.md'
    })
  })

  it('写作风格改名之后只换 style，不动 outline', async () => {
    await markRoles()
    await writeFile('overview/outline.md', '# 大纲\n')
    await writeFile('overview/style.md', '# 风格\n')

    const previousPath = path.join(overviewRoot(), 'style.md')
    const nextPath = path.join(overviewRoot(), '文风.md')
    await fs.rename(previousPath, nextPath)

    expect(await remapOverviewRole(root, previousPath, nextPath)).toBe(true)
    expect((await readProjectConfig())?.overview).toEqual({
      path: 'overview',
      outline: 'outline.md',
      style: '文风.md'
    })
  })

  it('普通文档改名时不动配置', async () => {
    await markRoles()
    await writeFile('overview/世界观.md', '# 世界观\n')

    const previousPath = path.join(overviewRoot(), '世界观.md')
    const nextPath = path.join(overviewRoot(), '设定.md')
    await fs.rename(previousPath, nextPath)

    expect(await remapOverviewRole(root, previousPath, nextPath)).toBe(false)
    expect((await readProjectConfig())?.overview).toEqual({
      path: 'overview',
      outline: 'outline.md',
      style: 'style.md'
    })
  })

  it('没有任何标记时改名不写配置', async () => {
    await loadProjectConfig(root)
    await writeFile('overview/大纲.md', '# 大纲\n')

    const previousPath = path.join(overviewRoot(), '大纲.md')
    const nextPath = path.join(overviewRoot(), '主线.md')
    await fs.rename(previousPath, nextPath)

    expect(await remapOverviewRole(root, previousPath, nextPath)).toBe(false)
    expect((await readProjectConfig())?.overview).toEqual({ path: 'overview' })
  })

  it('新名字不是 Markdown 时不改配置 —— 登记它会把配置自己写坏', async () => {
    await markRoles()
    await writeFile('overview/outline.md', '# 大纲\n')
    await writeFile('overview/style.md', '# 风格\n')

    const previousPath = path.join(overviewRoot(), 'outline.md')
    const nextPath = path.join(overviewRoot(), 'outline.txt')
    await fs.rename(previousPath, nextPath)

    expect(await remapOverviewRole(root, previousPath, nextPath)).toBe(false)
    expect((await readProjectConfig())?.overview).toEqual({
      path: 'overview',
      outline: 'outline.md',
      style: 'style.md'
    })
  })

  it('子目录里的文件不是标记对象，不改配置', async () => {
    await markRoles()
    await writeFile('overview/outline.md', '# 大纲\n')
    await writeFile('overview/style.md', '# 风格\n')
    await writeFile('overview/子目录/大纲.md', '# 大纲\n')

    const previousPath = path.join(overviewRoot(), '子目录', '大纲.md')
    const nextPath = path.join(overviewRoot(), '子目录', '主线.md')
    await fs.rename(previousPath, nextPath)

    expect(await remapOverviewRole(root, previousPath, nextPath)).toBe(false)
    expect((await readProjectConfig())?.overview).toEqual({
      path: 'overview',
      outline: 'outline.md',
      style: 'style.md'
    })
  })
})
