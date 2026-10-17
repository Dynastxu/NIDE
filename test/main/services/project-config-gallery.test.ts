import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  initializeProjectDirectory,
  loadGalleryRegistry,
  projectGalleryRegistryPath,
  updateGalleryRegistry
} from '../../../src/main/services/project-config.service'
import { readProjectGalleries } from '../../../src/main/services/project-files.service'
import {
  DEFAULT_CHARACTER_GALLERY_FIELDS,
  DEFAULT_GALLERY_REGISTRY,
  parseGalleryConfig,
  parseGalleryRegistry,
  serializeGalleryRegistry
} from '@shared/project'

/**
 * `.nide` 里那份图鉴注册表，以及「新建项目时默认建一个角色图鉴」这条要求。
 *
 * 这一段的结论都落在盘上，所以只有真的文件系统给得出来。用例重点撞两件事：
 *
 * 1. **新建项目**建出默认的角色图鉴（目录 + 字段表）并把它记进注册表 —— 章节表单的
 *    「出场角色」选的就是它（见 shared/project/gallery 的 GalleryRegistry）；
 * 2. **读盘不写用户内容**。注册表本身是宿主的元数据，被删就重建；而那个图鉴目录不是
 *    —— 用户删掉它之后，读一次注册表不该把它长回来（与「打开一个项目不会建任何东西」
 *    同一条边界）。
 */

let root = ''
const windows = process.platform === 'win32'

/** 默认角色图鉴的字段表路径 */
function characterConfigPath(): string {
  return path.join(root, 'gallery', DEFAULT_GALLERY_REGISTRY.characters, 'config.yml')
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
  // realpath：macOS 的 /var 是 /private/var 的链接，范围校验会因此判错
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nide-gallery-meta-')))
  root = path.join(base, 'project')
  await fs.mkdir(root, { recursive: true })
})

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true })
})

describe('新建项目的图鉴骨架', () => {
  it('建出默认的角色图鉴（目录 + 字段表），并把它记进 .nide/gallery.yml', async () => {
    await initializeProjectDirectory(root)

    const registry = parseGalleryRegistry(
      await fs.readFile(projectGalleryRegistryPath(root), 'utf-8')
    )
    expect(registry).toEqual(DEFAULT_GALLERY_REGISTRY)

    const parsed = parseGalleryConfig(await fs.readFile(characterConfigPath(), 'utf-8'))
    expect(parsed?.fields).toEqual([...DEFAULT_CHARACTER_GALLERY_FIELDS])

    // 从图鉴列表那一侧看过去，它就是普通的一个图鉴
    const listing = await readProjectGalleries(path.join(root, 'gallery'), {
      roots: [root],
      caseInsensitive: windows
    })
    expect(listing.ok).toBe(true)
    if (!listing.ok) return
    expect(listing.galleries.map((gallery) => gallery.name)).toEqual([
      DEFAULT_GALLERY_REGISTRY.characters
    ])
  })

  it('重复初始化是安全的空操作：用户改过的字段表与注册表都留着', async () => {
    await initializeProjectDirectory(root)

    const custom = serializeGalleryRegistry({ characters: '人物' })
    await fs.writeFile(projectGalleryRegistryPath(root), custom, 'utf-8')
    await fs.writeFile(characterConfigPath(), 'fields:\n  - 名称\n  - 我自己的字段\n', 'utf-8')

    await initializeProjectDirectory(root)

    expect(await fs.readFile(projectGalleryRegistryPath(root), 'utf-8')).toBe(custom)
    expect(parseGalleryConfig(await fs.readFile(characterConfigPath(), 'utf-8'))?.fields).toEqual([
      '名称',
      '我自己的字段'
    ])
  })
})

describe('读注册表', () => {
  it('文件不在时重建默认的一份', async () => {
    const registry = await loadGalleryRegistry(root)

    expect(registry).toEqual(DEFAULT_GALLERY_REGISTRY)
    expect(
      parseGalleryRegistry(await fs.readFile(projectGalleryRegistryPath(root), 'utf-8'))
    ).toEqual(DEFAULT_GALLERY_REGISTRY)
  })

  it('内容读不出来时用默认的一份覆盖它', async () => {
    await initializeProjectDirectory(root)
    await fs.writeFile(projectGalleryRegistryPath(root), 'characters: ../外面\n', 'utf-8')

    await loadGalleryRegistry(root)

    expect(
      parseGalleryRegistry(await fs.readFile(projectGalleryRegistryPath(root), 'utf-8'))
    ).toEqual(DEFAULT_GALLERY_REGISTRY)
  })

  it('**不**把用户删掉的图鉴建回来：读盘不写用户内容', async () => {
    await initializeProjectDirectory(root)
    await fs.rm(path.join(root, 'gallery', DEFAULT_GALLERY_REGISTRY.characters), {
      recursive: true,
      force: true
    })

    const registry = await loadGalleryRegistry(root)

    expect(registry).toEqual(DEFAULT_GALLERY_REGISTRY)
    expect(await exists(characterConfigPath())).toBe(false)
  })
})

describe('改注册表（设为角色图鉴）', () => {
  it('名字指向一个真的图鉴时写进去', async () => {
    await initializeProjectDirectory(root)
    await fs.mkdir(path.join(root, 'gallery', '人物'))

    expect(await updateGalleryRegistry(root, '人物')).toEqual({
      ok: true,
      registry: { characters: '人物' }
    })
    expect((await loadGalleryRegistry(root)).characters).toBe('人物')
  })

  it('名字不是合法的一段目录名时拒绝，什么都不写', async () => {
    await initializeProjectDirectory(root)

    for (const name of ['', '   ', '卷一/角色', '..', 'D:\\Novel']) {
      expect(await updateGalleryRegistry(root, name)).toEqual({ ok: false, reason: 'invalid-name' })
    }
    expect((await loadGalleryRegistry(root)).characters).toBe(DEFAULT_GALLERY_REGISTRY.characters)
  })

  it('图鉴目录不存在时拒绝 —— 指向一个不存在的图鉴等于让出场角色永远选不出东西', async () => {
    await initializeProjectDirectory(root)

    expect(await updateGalleryRegistry(root, '没有这个')).toEqual({
      ok: false,
      reason: 'unknown-gallery'
    })
    expect((await loadGalleryRegistry(root)).characters).toBe(DEFAULT_GALLERY_REGISTRY.characters)
  })

  it('不是字符串的载荷也拒绝（IPC 载荷完全不可信）', async () => {
    await initializeProjectDirectory(root)

    expect(await updateGalleryRegistry(root, 42)).toEqual({ ok: false, reason: 'invalid-name' })
    expect(await updateGalleryRegistry(root, null)).toEqual({ ok: false, reason: 'invalid-name' })
  })
})
