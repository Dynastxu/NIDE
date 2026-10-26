import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  initializeProjectDirectory,
  loadGalleryRegistry,
  loadProjectConfig,
  projectConfigPath,
  projectLegacyGalleryRegistryPath,
  updateGalleryRegistry
} from '../../packages/services/config/src/project-config.ts'
import { readProjectGalleries } from '../../packages/services/content/src/project-files.ts'
import {
  DEFAULT_CHARACTER_GALLERY_FIELDS,
  DEFAULT_GALLERY_REGISTRY,
  DEFAULT_PROJECT_CONFIG,
  parseGalleryConfig,
  parseProjectConfig,
  serializeProjectConfig
} from '../../packages/contracts/src/project/index.ts'

/**
 * `.nide/config.yml` 里的角色图鉴，以及「新建项目时默认建一个角色图鉴」这条要求。
 *
 * 这一段的结论都落在盘上，所以只有真的文件系统给得出来。用例重点撞三件事：
 *
 * 1. **新建项目**建出默认的角色图鉴（目录 + 字段表），并把它的名字记进配置里图鉴那
 *    一段的 `characters` —— 章节表单的「出场角色」选的就是它；
 * 2. **读盘不写用户内容**。配置本身是宿主的元数据，被删就重建；而那个图鉴目录不是
 *    —— 用户删掉它之后，读一次配置不该把它长回来（与「打开一个项目不会建任何东西」
 *    同一条边界）；
 * 3. **合并之前那一版**（扁平四项 + 单独的 `gallery.yml`）读到就合成一份新的写回去，
 *    旧文件随之后被删掉 —— 用户改过的目录名与角色图鉴都跟着留下。
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

/** 磁盘上那份 `config.yml` 读出来的配置 */
async function readConfig(): Promise<unknown> {
  return parseProjectConfig(await fs.readFile(projectConfigPath(root), 'utf-8'))
}

/** 合并之前那一版的两份文件 */
async function writeLegacyConfig(options: {
  characters?: string
  configText?: string
}): Promise<void> {
  const legacyConfig =
    options.configText ??
    [
      '# NIDE project configuration',
      'chapters: "manuscript"',
      'gallery: "gallery"',
      'foreshadowing: "notes"',
      'overview: "notes"'
    ].join('\n')

  await fs.mkdir(path.dirname(projectConfigPath(root)), { recursive: true })
  await fs.writeFile(projectConfigPath(root), legacyConfig, 'utf-8')

  if (options.characters !== undefined) {
    await fs.writeFile(
      projectLegacyGalleryRegistryPath(root),
      `# NIDE gallery registry\ncharacters: "${options.characters}"\n`,
      'utf-8'
    )
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
  it('建出默认的角色图鉴（目录 + 字段表），并把它记进 config.yml', async () => {
    await initializeProjectDirectory(root)

    // 新建项目也自带概述预设的两份文件，并把它们标记好
    expect(await readConfig()).toEqual({
      ...DEFAULT_PROJECT_CONFIG,
      overview: { path: 'overview', outline: 'outline.md', style: 'style.md' }
    })
    expect(await exists(path.join(root, 'overview', 'outline.md'))).toBe(true)
    expect(await exists(path.join(root, 'overview', 'style.md'))).toBe(true)

    const parsed = parseGalleryConfig(await fs.readFile(characterConfigPath(), 'utf-8'))
    expect(parsed?.fields).toEqual([...DEFAULT_CHARACTER_GALLERY_FIELDS])

    // 合并之后不再有第二份文件
    expect(await exists(projectLegacyGalleryRegistryPath(root))).toBe(false)

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

  it('重复初始化是安全的空操作：用户改过的字段表与配置都留着', async () => {
    await initializeProjectDirectory(root)

    const custom = serializeProjectConfig({
      chapters: { path: 'manuscript' },
      gallery: { path: 'gallery', characters: '人物' },
      foreshadowing: { path: 'notes' },
      overview: { path: 'notes' }
    })
    await fs.writeFile(projectConfigPath(root), custom, 'utf-8')
    await fs.writeFile(characterConfigPath(), 'fields:\n  - 名称\n  - 我自己的字段\n', 'utf-8')

    await initializeProjectDirectory(root)

    expect(await fs.readFile(projectConfigPath(root), 'utf-8')).toBe(custom)
    expect(parseGalleryConfig(await fs.readFile(characterConfigPath(), 'utf-8'))?.fields).toEqual([
      '名称',
      '我自己的字段'
    ])
  })
})

describe('读角色图鉴', () => {
  it('配置不在时重建默认的一份', async () => {
    const registry = await loadGalleryRegistry(root)

    expect(registry).toEqual(DEFAULT_GALLERY_REGISTRY)
    expect(await readConfig()).toEqual(DEFAULT_PROJECT_CONFIG)
  })

  it('内容读不出来时用默认的一份覆盖它', async () => {
    await initializeProjectDirectory(root)
    await fs.writeFile(projectConfigPath(root), 'gallery:\n  characters: ../外面\n', 'utf-8')

    await loadGalleryRegistry(root)

    expect(await readConfig()).toEqual(DEFAULT_PROJECT_CONFIG)
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

describe('改角色图鉴（设为角色图鉴）', () => {
  it('名字指向一个真的图鉴时写进配置，别的分区不动', async () => {
    await initializeProjectDirectory(root)
    await fs.mkdir(path.join(root, 'gallery', '人物'))

    expect(await updateGalleryRegistry(root, '人物')).toEqual({
      ok: true,
      registry: { characters: '人物' }
    })
    expect((await loadGalleryRegistry(root)).characters).toBe('人物')

    const config = await readConfig()
    expect(config).toEqual({
      ...DEFAULT_PROJECT_CONFIG,
      gallery: { path: 'gallery', characters: '人物' },
      overview: { path: 'overview', outline: 'outline.md', style: 'style.md' }
    })
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

describe('合并之前那一版的两份文件', () => {
  it('读到旧格式时合成一份新的写回去，旧文件被删掉', async () => {
    await writeLegacyConfig({ characters: '人物' })

    const config = await loadProjectConfig(root)

    expect(config).toEqual({
      chapters: { path: 'manuscript' },
      gallery: { path: 'gallery', characters: '人物' },
      foreshadowing: { path: 'notes' },
      overview: { path: 'notes' }
    })
    // 磁盘上已经是新格式，旧文件不再存在
    expect(await readConfig()).toEqual(config)
    expect(await exists(projectLegacyGalleryRegistryPath(root))).toBe(false)
  })

  it('旧版没有 gallery.yml 时用默认的角色图鉴名', async () => {
    await writeLegacyConfig({})

    expect(await loadProjectConfig(root)).toEqual({
      chapters: { path: 'manuscript' },
      gallery: { path: 'gallery', characters: DEFAULT_GALLERY_REGISTRY.characters },
      foreshadowing: { path: 'notes' },
      overview: { path: 'notes' }
    })
    expect(await exists(projectLegacyGalleryRegistryPath(root))).toBe(false)
  })

  it('旧版 gallery.yml 读不出来时同样合并且用默认名', async () => {
    await writeLegacyConfig({ characters: '卷一/角色' })

    const config = await loadProjectConfig(root)

    expect(config.gallery.characters).toBe(DEFAULT_GALLERY_REGISTRY.characters)
    expect(await exists(projectLegacyGalleryRegistryPath(root))).toBe(false)
  })

  it('两份文件都读不出来时按坏配置处理，写回默认配置', async () => {
    await writeLegacyConfig({ characters: '人物', configText: 'not-a-mapping\n' })

    expect(await loadProjectConfig(root)).toEqual(DEFAULT_PROJECT_CONFIG)
  })
})
