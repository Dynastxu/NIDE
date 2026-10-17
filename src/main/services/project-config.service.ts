import fs from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_CHARACTER_GALLERY_FIELDS,
  DEFAULT_PROJECT_CONFIG,
  DEFAULT_PROJECT_META_IGNORE,
  GALLERY_CONFIG_FILE_NAME,
  LEGACY_GALLERY_REGISTRY_FILE_NAME,
  PROJECT_CONFIG_FILE_NAME,
  PROJECT_CONFIG_KEYS,
  PROJECT_META_DIR_NAME,
  PROJECT_META_IGNORE_FILE_NAME,
  applyProjectConfigPatch,
  normalizeGalleryName,
  parseLegacyGalleryRegistry,
  parseLegacyProjectConfig,
  parseProjectConfig,
  sanitizeProjectConfigPatch,
  serializeGalleryConfig,
  serializeProjectConfig
} from '@shared/project'
import { loggerFor } from '../logger'
import type {
  GalleryRegistry,
  GalleryRegistryUpdateResult,
  ProjectConfig,
  ProjectConfigKey,
  ProjectConfigUpdateResult
} from '@shared/project'

const logger = loggerFor('project-config')

/**
 * 项目级配置（`.nide`）的落盘。
 *
 * 与 project-files.service 分工一致：不认识窗口、不认识 IPC，只回答「配置是什么」
 * 与「把它改成什么」。范围由调用方（IPC 层）收窄成当前项目 —— 这里的每个入口都
 * 只收一个**项目根**，不收任意路径。
 *
 * ## 两条刻意的行为差异
 *
 * 1. **初始化只在创建项目时发生**（`initializeProjectDirectory`）。打开一个已有
 *    项目是「读它本来的样子」，一个被删掉内容目录的项目不该因为被打开一次就长出
 *    目录来 —— 那会让用户以为自己删错了东西。
 * 2. **读写时静默重建 `.nide` 本身**（`loadProjectConfig`）。它是宿主的元数据，
 *    不是用户的稿子：删掉它只意味着「回到默认配置」，而不是「这个项目坏了」。
 *    所以这种情况不弹错、不阻塞，写回默认配置后照常返回。
 *    重建的只有 `.nide` 与配置里写明的四个目录，其余一律不碰。
 *
 * ## 一份文件
 *
 * `.nide` 里只有一份 `config.yml`：四个内容分区各一段，图鉴那一段多记一个
 * `characters`（哪个图鉴是角色图鉴，见 shared/project/config）。它原先单独记在
 * 同目录的 `gallery.yml` 里，两份文件改的是同一件事，删掉其中一份就只剩半份配置。
 *
 * 旧项目仍要能打开，所以 `loadProjectConfig` 读到**合并之前那一版**（扁平四项）
 * 时会把它与 `gallery.yml` 合成一份新的写回去，随后删掉那份已经并进来的
 * `gallery.yml`（见 `mergeLegacyProjectConfig`）。这条迁移只发生一次：写回去的是
 * 新格式，下一次就按新格式直接读。
 *
 * 配置被删就重建，而**图鉴不是**：读一次盘不会把用户删掉的那个默认图鉴建回来 ——
 * 内容目录由配置写明、里面是空目录，而图鉴是用户内容（有字段表、进版本库）——
 * 读一次盘就把它建出来会越过「打开项目不建东西」的边界。
 */

/** 一份默认配置的**副本**。常量本身不共享给调用方，免得被就地改掉 */
function defaultConfig(): ProjectConfig {
  return {
    chapters: { ...DEFAULT_PROJECT_CONFIG.chapters },
    gallery: { ...DEFAULT_PROJECT_CONFIG.gallery },
    foreshadowing: { ...DEFAULT_PROJECT_CONFIG.foreshadowing },
    overview: { ...DEFAULT_PROJECT_CONFIG.overview }
  }
}

/** `<root>/.nide` */
export function projectMetaDir(root: string): string {
  return path.join(root, PROJECT_META_DIR_NAME)
}

/** `<root>/.nide/config.yml` */
export function projectConfigPath(root: string): string {
  return path.join(projectMetaDir(root), PROJECT_CONFIG_FILE_NAME)
}

/** `<root>/.nide/.gitignore` */
export function projectMetaIgnorePath(root: string): string {
  return path.join(projectMetaDir(root), PROJECT_META_IGNORE_FILE_NAME)
}

/**
 * `<root>/.nide/gallery.yml` —— 合并之前那一版的图鉴注册表。
 *
 * 只用于迁移：读到旧格式的配置时把这份文件并进 `config.yml`，随后删掉它。
 */
export function projectLegacyGalleryRegistryPath(root: string): string {
  return path.join(projectMetaDir(root), LEGACY_GALLERY_REGISTRY_FILE_NAME)
}

/**
 * 把配置里的相对目录解析成绝对路径。
 *
 * 值已经是校验过的（见 normalizeConfigDirectory）：不含 `..`、不是绝对路径，
 * 所以拼出来的结果一定在 root 之内。用 `path.join` 而不是 `resolve`：后者会顺手
 * 规范化 `a/../b` 这类写法，而这里不需要它替我们做判断。
 */
export function resolveConfigDirectory(root: string, relative: string): string {
  return path.join(root, ...relative.split('/'))
}

/** 读一个文本文件的结果：内容与「读失败但不是文件不存在」的原因 */
interface ReadTextResult {
  /** 文件内容；不存在或读不出来时是 null */
  text: string | null
  /** 读失败的原因；文件本来就不存在时是 null（那是常态，不该记成警告） */
  error: unknown
}

async function readTextFile(target: string): Promise<ReadTextResult> {
  try {
    return { text: await fs.readFile(target, 'utf-8'), error: null }
  } catch (err) {
    return { text: null, error: isMissingFileError(err) ? null : err }
  }
}

/** 按配置建目录。返回没能建出来的那些（键） */
async function ensureDirectories(root: string, config: ProjectConfig): Promise<ProjectConfigKey[]> {
  const failed: ProjectConfigKey[] = []

  for (const key of PROJECT_CONFIG_KEYS) {
    const target = resolveConfigDirectory(root, config[key].path)

    try {
      /**
       * recursive：配置允许多段路径（`chapters/volume-1`），中间层要一起建出来；
       * 目录已存在时它什么都不做，正是「只管建、不覆盖」的语义。
       */
      await fs.mkdir(target, { recursive: true })
    } catch (err) {
      // 单个目录建不出来（权限、同名文件占位）不该让整次读写失败：
      // 另外三个目录仍然是可用的
      logger.warn('Failed to create a project directory', { key, error: err })
      failed.push(key)
    }
  }

  return failed
}

/** 写 `.nide/.gitignore`。只在它不存在时写，不覆盖用户改过的那份 */
async function ensureMetaIgnoreFile(root: string): Promise<void> {
  try {
    await fs.writeFile(projectMetaIgnorePath(root), DEFAULT_PROJECT_META_IGNORE, {
      encoding: 'utf-8',
      flag: 'wx'
    })
  } catch (err) {
    // EEXIST 是常态（每次读配置都可能走到这里），只有别的错误值得记一行
    if ((err as { code?: unknown } | null)?.code !== 'EEXIST') {
      logger.warn('Failed to create the .nide ignore file', { error: err })
    }
  }
}

/**
 * 写配置文件，返回是否真的写了。
 *
 * **只有磁盘上的内容与本模块写出来的规范写法不一致时才写**：每次读配置都会走到
 * 这条路径（`.nide` 被删之后的重建），每次都摸一遍文件的修改时间没有意义。这个
 * 判断也是「人手把配置改成规范写法」的收敛点：格式与值都一致就不动它。
 */
async function writeProjectConfig(root: string, config: ProjectConfig): Promise<boolean> {
  const target = projectConfigPath(root)
  const text = serializeProjectConfig(config)

  try {
    const existing = parseProjectConfig(await fs.readFile(target, 'utf-8'))
    // 已经是同一份配置（哪怕写法不同）就不动它
    if (existing !== null && serializeProjectConfig(existing) === text) return false
  } catch {
    // 读不出来（不存在、坏掉、没权限）都要走下面那次写入：
    // 不存在要建，坏掉要被这份配置覆盖
  }

  try {
    await fs.mkdir(projectMetaDir(root), { recursive: true })
    await fs.writeFile(target, text, 'utf-8')
    return true
  } catch (err) {
    logger.warn('Failed to write the project configuration', { error: err })
    return false
  }
}

/**
 * 读项目配置；`.nide` 或配置文件缺失、坏掉时静默回落成默认配置并写回。
 *
 * 这是**读配置的唯一入口**，也是「`.nide` 被删掉要重新生成」这条要求的落点：
 * 删掉 `.nide` 的后果应当是「配置回到默认」，而不是「这个项目打不开了」。
 *
 * 写回默认配置只在文件不存在或解析失败时发生，而写出来的就是默认配置，所以下一次
 * 读不会再写。五种情形：
 *
 * - 文件在、新格式合法：直接用；
 * - 文件在、是**合并之前那一版**（扁平四项）：与 `.nide/gallery.yml` 合成一份新的
 *   写回去，随后删掉那份旧文件（见 mergeLegacyProjectConfig）；
 * - 文件不在（含 `.nide` 自己被删）：写默认配置 + 建四个目录；
 * - 文件在但读不出来（权限、坏符号链接）：同上，用默认配置覆盖它 —— 一份读不懂的
 *   配置留着的唯一后果是每次启动都要再失败一次；
 * - 文件在但缺键，或用了嵌套结构这类本模块不认的写法：判为坏配置，理由见
 *   parseProjectConfig。
 *
 * 无论走哪一条，收尾都会补上 `.nide/.gitignore` 与四个内容目录（只补不覆盖）。
 */
export async function loadProjectConfig(root: string): Promise<ProjectConfig> {
  const { text, error } = await readTextFile(projectConfigPath(root))

  let config: ProjectConfig | null = null

  if (text !== null) {
    config = parseProjectConfig(text)
    if (config === null) config = await mergeLegacyProjectConfig(root, text)
    if (config === null) logger.warn('The project configuration is invalid; regenerating it')
  } else if (error !== null) {
    logger.warn('The project configuration could not be read; regenerating it', { error })
  }

  if (config === null) {
    config = defaultConfig()
    await writeProjectConfig(root, config)
  }

  /*
   * 补文件的动作每次都做，且都只补不覆盖：
   *
   * - `.gitignore` 可能和配置一起被删（整个 `.nide` 被删就是这种情形），它属于
   *   「被删就重建」的那一层；
   * - 内容目录被手删过时补回来：配置说它在那儿，而树要能点开它。
   */
  await ensureMetaIgnoreFile(root)
  await ensureDirectories(root, config)

  return config
}

/**
 * 把合并之前那一版两份文件合成一份配置。
 *
 * 旧版 `config.yml` 是扁平四项，角色图鉴记在另一份 `.nide/gallery.yml` 里。返回的
 * 是新格式的配置（已经写回磁盘，旧文件随后被删掉）；不是旧格式时给 null，调用方
 * 据此判为坏配置。
 *
 * `gallery.yml` 读不出来时用默认的角色图鉴名，并且**不**阻止这次合并：一份读不懂
 * 的旧文件留着的唯一后果是每次启动都要再失败一次。
 */
async function mergeLegacyProjectConfig(root: string, raw: string): Promise<ProjectConfig | null> {
  const legacy = parseLegacyProjectConfig(raw)
  if (legacy === null) return null

  const { text } = await readTextFile(projectLegacyGalleryRegistryPath(root))
  const characters = text === null ? null : parseLegacyGalleryRegistry(text)

  if (text !== null && characters === null) {
    logger.warn(
      'The legacy gallery registry could not be read; using the default character gallery'
    )
  }

  const config: ProjectConfig = {
    chapters: { path: legacy.chapters },
    gallery: {
      path: legacy.gallery,
      characters: characters ?? DEFAULT_PROJECT_CONFIG.gallery.characters
    },
    foreshadowing: { path: legacy.foreshadowing },
    overview: { path: legacy.overview }
  }

  const written = await writeProjectConfig(root, config)
  // 写不进去时那份旧文件还是唯一记着角色图鉴的地方，不能删
  if (written) {
    await removeLegacyGalleryRegistry(root)
    logger.info('Merged the legacy project configuration')
  }

  return config
}

/** 删掉合并之后不再使用的 `.nide/gallery.yml`。删不掉不算失败：配置已经合并好了 */
async function removeLegacyGalleryRegistry(root: string): Promise<void> {
  try {
    await fs.rm(projectLegacyGalleryRegistryPath(root), { force: true })
  } catch (err) {
    logger.warn('Failed to remove the merged legacy gallery registry', { error: err })
  }
}

/** ENOENT：文件（或它的上级目录）不存在。这是常态，不该记成警告 */
function isMissingFileError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT'
}

// ============ 角色图鉴（.nide/config.yml 的 gallery.characters） ============

/**
 * 把默认的角色图鉴建出来：一个目录 + 它的 `config.yml`。
 *
 * **只建不覆盖**：目录已经在了就什么都不做，字段表已经在了就留着用户那份 —— 用户在
 * 那个图鉴里加过字段之后，宿主每次新建项目都把它改回默认值是不可接受的。
 *
 * 只由 `initializeProjectDirectory` 调用（见 loadProjectConfig 里那条说明：读盘
 * 不建用户内容）。建不出来（只读目录、权限不足）只记一行：项目仍然可用，只是少了
 * 那个默认图鉴。
 */
async function ensureDefaultGallery(
  root: string,
  config: ProjectConfig,
  name: string,
  fields: readonly string[]
): Promise<void> {
  const galleryName = normalizeGalleryName(name)
  if (galleryName === null) return

  try {
    const dir = path.join(resolveConfigDirectory(root, config.gallery.path), galleryName)

    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, GALLERY_CONFIG_FILE_NAME),
      serializeGalleryConfig({ fields: [...fields] }),
      { encoding: 'utf-8', flag: 'wx' }
    )
  } catch (err) {
    // 目录与字段表都已存在时是 EEXIST，那是常态（这里只建不覆盖），只有别的错误值得记一行
    if ((err as { code?: unknown } | null)?.code !== 'EEXIST') {
      logger.warn('Failed to create the default gallery', { name, error: err })
    }
  }
}

/**
 * 读图鉴注册表；配置缺失或读坏时由 `loadProjectConfig` 静默回落成默认配置。
 *
 * 注册表现在是项目配置里图鉴那一段的 `characters`，不再是一份单独的文件：两者改的
 * 是同一件事（项目结构），分成两份文件时删掉其中一份就只剩半份配置。
 *
 * 这里**不**顺手把那个默认的角色图鉴建出来 —— 图鉴是**用户内容**（它在图鉴内容
 * 目录里、跟着项目进版本库、字段表由用户改），而「读一次盘就替人建一份内容」正是
 * 那条「打开一个项目不会建任何东西」的边界。默认图鉴只在**新建项目**时建一次
 * （见 initializeProjectDirectory）。
 *
 * 代价说清楚：配置里记着的那个图鉴可能并不存在。那在界面上是可见且可修的（章节
 * 表单的出场角色会说明「还没有角色图鉴」，图鉴面板里可以新建一个、或者把已有的
 * 那个设成角色图鉴）—— 比宿主偷偷长出一个用户删过的目录好。
 *
 * 注册表本身**不**按图鉴列表纠正：用户把角色图鉴改名或删掉之后，配置里仍然指着
 * 原来的名字（宿主不追着用户改配置），要换一个走 `updateGalleryRegistry`。
 */
export async function loadGalleryRegistry(root: string): Promise<GalleryRegistry> {
  const config = await loadProjectConfig(root)
  return { characters: config.gallery.characters }
}

/**
 * 改注册表：把某一个图鉴设成角色图鉴。
 *
 * 名字必须是**图鉴目录里真的存在的一个目录**：注册表指向一个不存在的图鉴时，章节表单
 * 的出场角色永远选不出东西，而用户看不到任何原因。所以这一层先读一次盘再写。
 *
 * 校验不过时**一个字节都不写**，返回的注册表仍然是配置里那一份。
 */
export async function updateGalleryRegistry(
  root: string,
  rawName: unknown
): Promise<GalleryRegistryUpdateResult> {
  const name = typeof rawName === 'string' ? normalizeGalleryName(rawName) : null
  if (name === null) {
    logger.warn('Refused a gallery registry update with an invalid name')
    return { ok: false, reason: 'invalid-name' }
  }

  const config = await loadProjectConfig(root)
  const dir = path.join(resolveConfigDirectory(root, config.gallery.path), name)

  try {
    const stats = await fs.stat(dir)
    if (!stats.isDirectory()) return { ok: false, reason: 'unknown-gallery' }
  } catch (err) {
    // 目录不在：用户点的是图鉴列表里的一项，走到这里说明那份列表已经过期
    if (isMissingFileError(err)) return { ok: false, reason: 'unknown-gallery' }

    logger.warn('Failed to stat a gallery while updating the registry', { error: err })
    return { ok: false, reason: 'unreadable' }
  }

  const next: ProjectConfig = { ...config, gallery: { ...config.gallery, characters: name } }
  const written = await writeProjectConfig(root, next)

  logger.info('Gallery registry updated', { written })
  return { ok: true, registry: { characters: name } }
}

/**
 * 更新项目配置并把目录补齐。
 *
 * 落盘的**只有 `.nide/config.yml`**：目录是补出来的副作用（旧名字的目录保留，
 * 里面可能有用户已经写好的稿子，宿主没有资格替人删）。所以改一次配置不会丢内容。
 *
 * 校验不合格时**一项都不写**（见 applyProjectConfigPatch）：半生效的配置比整条
 * 拒绝更难查。返回值里带着被拒绝的键，界面据此说明原因。
 */
export async function updateProjectConfig(
  root: string,
  patch: unknown
): Promise<ProjectConfigUpdateResult> {
  const current = await loadProjectConfig(root)
  const applied = applyProjectConfigPatch(current, sanitizeProjectConfigPatch(patch))

  if (!applied.ok) {
    logger.warn('Refused a project configuration update', {
      rejected: applied.rejected,
      conflicts: applied.conflicts
    })
    return { ok: false, config: current, rejected: applied.rejected, conflicts: applied.conflicts }
  }

  const written = await writeProjectConfig(root, applied.config)
  if (written) await ensureMetaIgnoreFile(root)
  await ensureDirectories(root, applied.config)

  logger.info('Project configuration updated', {
    written,
    // 只记改动了几项，不记值：值里是用户自己的目录命名，日志不需要抄一份
    changed: Object.keys(patch ?? {}).length
  })

  return { ok: true, config: applied.config, rejected: [], conflicts: [] }
}

/**
 * 创建项目时的初始化：写默认配置与 `.gitignore`、按配置建内容目录，以及建出默认的
 * 角色图鉴。
 *
 * **只在用户经「新建项目」选定目录时调用一次**，打开已有目录不走这里（见文件头）。
 * 已经存在的东西一律不覆盖：`.nide` 在（哪怕是别的工具建的）就沿用它的配置，
 * `.gitignore` 在就留着用户那份。所以对已有项目重复调用是安全的空操作。
 *
 * 读配置走 `loadProjectConfig`（它与「读一次配置」同一条路：缺失就重建、旧格式就
 * 合并），因此这里不必再自己解析一遍文件。
 */
export async function initializeProjectDirectory(root: string): Promise<ProjectConfig> {
  const config = await loadProjectConfig(root)

  /**
   * 默认的角色图鉴要建在**配置里记着的那个名字**上：一个已经带着自己的配置
   * （例如角色图鉴改成了「人物」）的项目被重新初始化时，不该凭空多出一个图鉴。
   *
   * **这件事只在这里做**：新建项目是唯一「宿主可以往项目里放骨架」的时刻。读配置
   * 那条路只重建 `.nide` 里那一份文件，不会把用户删掉的图鉴长回来。
   */
  await ensureDefaultGallery(
    root,
    config,
    config.gallery.characters,
    DEFAULT_CHARACTER_GALLERY_FIELDS
  )

  logger.info('Project directory initialized', { dir: PROJECT_META_DIR_NAME })
  return config
}
