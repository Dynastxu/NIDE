import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostProjectStore } from '../../packages/host/src/services/project-store.ts'
import { PROJECTS_FILE_NAME } from '../../packages/contracts/src/project/store.ts'

/**
 * host 侧的「打开过的项目」。
 *
 * 这份 store 现在是 `projects.json` 的**唯一**实现（shell 那份已经删掉），所以这里
 * 撞的是它整套语义：打开 / 移除 / 关闭 / 启动时恢复，以及「记录留着、目录没了」这种
 * 必须靠读盘才能发现的状态。
 *
 * 全部用真的临时目录：这个类就是碰盘的，mock 掉 fs 等于把它测成另一段代码。
 */

let base = ''
let userDataDir = ''

function store(): HostProjectStore {
  return new HostProjectStore(userDataDir)
}

/** 读一眼落盘的内容 —— 断言「真的写下去了」，而不是只看内存 */
async function readFileStore(): Promise<{ lastOpened: string | null; projects: unknown[] }> {
  const raw = await fs.readFile(path.join(userDataDir, PROJECTS_FILE_NAME), 'utf-8')
  return JSON.parse(raw) as { lastOpened: string | null; projects: unknown[] }
}

/** 造一个还存在的项目目录 */
async function makeProject(name: string): Promise<string> {
  const dir = path.join(base, 'projects', name)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nide-projects-')))
  userDataDir = path.join(base, 'user-data')
  await fs.mkdir(userDataDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

describe('HostProjectStore：打开', () => {
  it('首次打开一个目录：记进列表、落盘、标成当前项目', async () => {
    const dir = await makeProject('one')
    const projects = store()

    const result = projects.open(dir)

    expect(result).toEqual({ ok: true, project: { path: dir, openedAt: expect.any(Number) } })
    expect(projects.getCurrent()?.path).toBe(dir)
    expect(projects.list().map((item) => [item.path, item.missing])).toEqual([[dir, false]])

    const written = await readFileStore()
    expect(written.lastOpened).toBe(dir)
    expect(written.projects).toHaveLength(1)
  })

  it('目录不存在 / 不是目录时给出原因，且不写盘', async () => {
    const missing = path.join(base, 'projects', 'nope')
    const file = path.join(base, 'plain.txt')
    await fs.writeFile(file, 'x', 'utf-8')
    const projects = store()

    expect(projects.open(missing)).toEqual({ ok: false, reason: 'missing', path: missing })
    expect(projects.open(file)).toEqual({ ok: false, reason: 'not-a-directory', path: file })
    expect(projects.getCurrent()).toBeNull()

    await expect(fs.stat(path.join(userDataDir, PROJECTS_FILE_NAME))).rejects.toThrow()
  })

  it('重复打开同一个目录：列表里仍是一条，并挪到最前', async () => {
    const first = await makeProject('first')
    const second = await makeProject('second')
    const projects = store()

    projects.open(first)
    projects.open(second)
    projects.open(first)

    const list = projects.list()
    expect(list.map((item) => item.path)).toEqual([first, second])
    expect(new Set(list.map((item) => item.path)).size).toBe(list.length)
    expect((await readFileStore()).lastOpened).toBe(first)
  })

  it('列表标出「目录已经不在」的记录，但不自动清理', async () => {
    const dir = await makeProject('gone')
    const projects = store()
    projects.open(dir)

    await fs.rm(dir, { recursive: true, force: true })

    expect(projects.list()).toEqual([{ path: dir, openedAt: expect.any(Number), missing: true }])
    // 记录还在磁盘上：一块没插上的盘不该让用户丢掉列表里的一行
    expect((await readFileStore()).projects).toHaveLength(1)
  })
})

describe('HostProjectStore：移除与关闭', () => {
  it('移除只删记录，磁盘上的目录不动，返回后的列表立刻是新的', async () => {
    const keep = await makeProject('keep')
    const drop = await makeProject('drop')
    const projects = store()
    projects.open(keep)
    projects.open(drop)

    projects.forget(drop)

    expect(projects.list().map((item) => item.path)).toEqual([keep])
    expect((await readFileStore()).lastOpened).toBe(keep)
    // 目录本身还在
    await expect(fs.stat(drop)).resolves.toBeTruthy()
  })

  it('移除当前项目会把「当前」清掉', async () => {
    const dir = await makeProject('current')
    const projects = store()
    projects.open(dir)

    projects.forget(dir)

    expect(projects.getCurrent()).toBeNull()
  })

  it('移除一条不存在的记录：什么都不变', async () => {
    const dir = await makeProject('only')
    const projects = store()
    projects.open(dir)
    const before = await readFileStore()

    projects.forget(path.join(base, 'projects', 'unknown'))

    expect(await readFileStore()).toEqual(before)
    expect(projects.getCurrent()?.path).toBe(dir)
  })

  it('关闭项目只动这一次会话：记录与 lastOpened 都留着', async () => {
    const dir = await makeProject('closed')
    const projects = store()
    projects.open(dir)

    projects.close()

    expect(projects.getCurrent()).toBeNull()
    expect(projects.list().map((item) => item.path)).toEqual([dir])
    expect((await readFileStore()).lastOpened).toBe(dir)
  })
})

describe('HostProjectStore：启动与窗口绑定', () => {
  it('重启后恢复上次打开的项目', async () => {
    const dir = await makeProject('resume')
    store().open(dir)

    const restarted = store()
    expect(restarted.resolveStartup()).toEqual({ path: dir, openedAt: expect.any(Number) })
    expect(restarted.getCurrent()?.path).toBe(dir)
  })

  it('上次打开的那个目录没了：不恢复，但记录留在列表里', async () => {
    const dir = await makeProject('vanished')
    store().open(dir)
    await fs.rm(dir, { recursive: true, force: true })

    const restarted = store()
    expect(restarted.resolveStartup()).toBeNull()
    expect(restarted.getCurrent()).toBeNull()
    expect(restarted.list().map((item) => item.missing)).toEqual([true])
  })

  it('一次都没打开过时，启动结论是「没有项目」', () => {
    const restarted = store()
    expect(restarted.resolveStartup()).toBeNull()
    expect(restarted.list()).toEqual([])
  })

  it('窗口绑定只认列表里已有的记录', async () => {
    const dir = await makeProject('bound')
    const other = await makeProject('other')
    const projects = store()
    projects.open(dir)

    expect(projects.setCurrent(other)).toBeNull()
    expect(projects.getCurrent()).toBeNull()

    expect(projects.setCurrent(dir)?.path).toBe(dir)
    // 空路径 = 这个窗口没有项目（欢迎窗口），不是「新增一条」
    expect(projects.setCurrent('')).toBeNull()
    expect(projects.list()).toHaveLength(1)
  })
})

describe('HostProjectStore：坏数据', () => {
  it('文件坏掉 / 版本不认识时回落成空列表，不抛', async () => {
    const broken = new HostProjectStore(userDataDir)
    await fs.writeFile(path.join(userDataDir, PROJECTS_FILE_NAME), '{ not json', 'utf-8')

    expect(broken.list()).toEqual([])
    expect(broken.resolveStartup()).toBeNull()

    await fs.writeFile(
      path.join(userDataDir, PROJECTS_FILE_NAME),
      JSON.stringify({ version: 999, lastOpened: null, projects: [] }),
      'utf-8'
    )

    expect(new HostProjectStore(userDataDir).list()).toEqual([])
  })

  it('一条坏记录不会带走其他好记录', async () => {
    const dir = await makeProject('good')
    await fs.writeFile(
      path.join(userDataDir, PROJECTS_FILE_NAME),
      JSON.stringify({
        version: 1,
        lastOpened: dir,
        projects: [{ path: 42 }, { path: dir, openedAt: 1 }]
      }),
      'utf-8'
    )

    const projects = new HostProjectStore(userDataDir)
    expect(projects.list().map((item) => item.path)).toEqual([dir])
    expect(projects.resolveStartup()?.path).toBe(dir)
  })
})
