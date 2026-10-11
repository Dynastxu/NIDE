import fs from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_PROJECT_CONFIG,
  DEFAULT_PROJECT_META_IGNORE,
  PROJECT_CONFIG_FILE_NAME,
  PROJECT_CONFIG_KEYS,
  PROJECT_META_DIR_NAME,
  PROJECT_META_IGNORE_FILE_NAME,
  applyProjectConfigPatch,
  parseProjectConfig,
  sanitizeProjectConfigPatch,
  serializeProjectConfig
} from '@shared/project'
import { loggerFor } from '../logger'
import type { ProjectConfig, ProjectConfigKey, ProjectConfigUpdateResult } from '@shared/project'

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
 */

/** 一份默认配置的**副本**。常量本身不共享给调用方，免得被就地改掉 */
function defaultConfig(): ProjectConfig {
  return { ...DEFAULT_PROJECT_CONFIG }
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
 * 把配置里的相对目录解析成绝对路径。
 *
 * 值已经是校验过的（见 normalizeConfigDirectory）：不含 `..`、不是绝对路径，
 * 所以拼出来的结果一定在 root 之内。用 `path.join` 而不是 `resolve`：后者会顺手
 * 规范化 `a/../b` 这类写法，而这里不需要它替我们做判断。
 */
export function resolveConfigDirectory(root: string, relative: string): string {
  return path.join(root, ...relative.split('/'))
}

/** 按配置建目录。返回没能建出来的那些（键） */
async function ensureDirectories(root: string, config: ProjectConfig): Promise<ProjectConfigKey[]> {
  const failed: ProjectConfigKey[] = []

  for (const key of PROJECT_CONFIG_KEYS) {
    const target = resolveConfigDirectory(root, config[key])

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
 * 读不会再写。四种情形：
 *
 * - 文件在、内容合法：直接用；
 * - 文件不在（含 `.nide` 自己被删）：写默认配置 + 建四个目录；
 * - 文件在但读不出来（权限、坏符号链接）：同上，用默认配置覆盖它 —— 一份读不懂的
 *   配置留着的唯一后果是每次启动都要再失败一次；
 * - 文件在但缺键，或用了嵌套结构这类本模块不认的写法：判为坏配置，理由见
 *   parseProjectConfig。
 *
 * 无论走哪一条，收尾都会补上 `.nide/.gitignore` 与四个内容目录（只补不覆盖）。
 */
export async function loadProjectConfig(root: string): Promise<ProjectConfig> {
  const target = projectConfigPath(root)

  let raw: string | null = null
  let readError: unknown = null

  try {
    raw = await fs.readFile(target, 'utf-8')
  } catch (err) {
    readError = err
  }

  let config: ProjectConfig

  if (raw !== null) {
    const parsed = parseProjectConfig(raw)

    if (parsed === null) {
      logger.warn('The project configuration is invalid; regenerating it')
      config = defaultConfig()
      await writeProjectConfig(root, config)
    } else {
      config = parsed
    }
  } else {
    if (readError !== null && !isMissingFileError(readError)) {
      logger.warn('The project configuration could not be read; regenerating it', {
        error: readError
      })
    }

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

/** ENOENT：文件（或它的上级目录）不存在。这是常态，不该记成警告 */
function isMissingFileError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT'
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
 * 创建项目时的初始化：建 `.nide`、写默认配置与 `.gitignore`、按配置建内容目录。
 *
 * **只在用户经「新建项目」选定目录时调用一次**，打开已有目录不走这里（见文件头）。
 * 已经存在的东西一律不覆盖：`.nide` 在（哪怕是别的工具建的）就沿用它的配置，
 * `.gitignore` 在就留着用户那份。所以对已有项目重复调用是安全的空操作。
 */
export async function initializeProjectDirectory(root: string): Promise<ProjectConfig> {
  const target = projectConfigPath(root)
  let config = defaultConfig()

  try {
    await fs.mkdir(projectMetaDir(root), { recursive: true })

    let raw: string | null = null
    try {
      raw = await fs.readFile(target, 'utf-8')
    } catch {
      raw = null
    }

    const parsed = raw === null ? null : parseProjectConfig(raw)
    config = parsed ?? defaultConfig()

    if (parsed === null) {
      await fs.writeFile(target, serializeProjectConfig(config), 'utf-8')
    }
  } catch (err) {
    /**
     * 建不出来（只读目录、权限不足）不是打开项目失败的理由：项目仍然可以用，
     * 只是没有配置目录。这里只记一行，配置按默认值返回。
     */
    logger.warn('Failed to initialize the project directory', { error: err })
    return config
  }

  await ensureMetaIgnoreFile(root)
  await ensureDirectories(root, config)
  logger.info('Project directory initialized', { dir: PROJECT_META_DIR_NAME })

  return config
}
