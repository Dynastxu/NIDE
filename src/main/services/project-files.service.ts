import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent, Stats } from 'node:fs'
import {
  MAX_TEXT_FILE_BYTES,
  completeFileName,
  createNameCollator,
  isIgnoredDirectoryName,
  isInsideProject,
  isSupportedTextPath,
  sortTreeEntries,
  validateEntryName
} from '@shared/project'
import { loggerFor } from '../logger'
import type {
  CreateEntryRequest,
  CreateEntryResult,
  CreateEntryFailureReason,
  DirReadResult,
  FileReadResult,
  FileTreeEntry,
  FileUnsupportedReason
} from '@shared/project'

const logger = loggerFor('project-files')

/**
 * 项目文件树的读盘与新建。
 *
 * 与 project-store 一样，这里不认识窗口、不认识 IPC —— 「这次请求合法吗」由
 * IPC 层判断（它才拿得到「当前项目」，也是唯一知道允许访问哪些根的地方）。
 * 这个模块只回答两件事：这个路径上有什么、以及在这儿新建一个条目成不成。
 *
 * 读与写都在这个文件里，**共用同一条范围校验**（isInsideAnyRoot）：分成两个模块
 * 就会有两套「什么算根内」的判断，而它们迟早会不一致 —— 不一致的那一天，
 * 边界就只剩下一半。
 */

/** 允许访问的根。读取与写入共用 */
export interface RootsOptions {
  /**
   * 允许访问的根目录集合。
   *
   * 是**集合**而不是单个根：目前只有当前项目一个，但临时文件夹将来要作为第二个
   * 根挂进同一棵树（见 renderer 的 explorer.store）。
   */
  roots: readonly string[]
  /** 路径比较是否忽略大小写。Windows 的路径不区分大小写，由调用方按平台给 */
  caseInsensitive: boolean
}

/** 目标路径是否落在**任意一个**允许的根之内 */
function isInsideAnyRoot(
  roots: readonly string[],
  target: string,
  caseInsensitive: boolean
): boolean {
  return roots.some((root) => root.length > 0 && isInsideProject(root, target, caseInsensitive))
}

/**
 * 读一层目录。
 *
 * 刻意**不递归**：整棵树一次读完在小说项目上尚可，但目录一大就是一次长卡顿，
 * 而且每一层都要重新读一遍。逐层展开把代价摊到用户真的想看的那一层。
 */
export async function readProjectDir(
  dirPath: string,
  options: RootsOptions
): Promise<DirReadResult> {
  if (typeof dirPath !== 'string' || dirPath.length === 0) {
    return { ok: false, reason: 'invalid-path' }
  }

  if (!isInsideAnyRoot(options.roots, dirPath, options.caseInsensitive)) {
    logger.warn('Refused to read a directory outside every known root', { dir: dirPath })
    return { ok: false, reason: 'outside-project' }
  }

  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(dirPath, { withFileTypes: true })
  } catch (err) {
    logger.warn('Failed to read a directory', { dir: dirPath, error: err })
    return { ok: false, reason: 'unreadable' }
  }

  const entries: FileTreeEntry[] = []

  for (const dirent of dirents) {
    const entryPath = path.join(dirPath, dirent.name)

    if (dirent.isDirectory()) {
      // 忽略表按原样比对：`.git` 与 `.Git` 是两个目录，忽略的是前者
      if (isIgnoredDirectoryName(dirent.name)) continue
      entries.push({ kind: 'directory', path: entryPath, name: dirent.name })
      continue
    }

    if (dirent.isFile()) {
      const unsupported = await fileUnsupportedReason(entryPath)
      entries.push({
        kind: 'file',
        path: entryPath,
        name: dirent.name,
        supported: unsupported === null,
        ...(unsupported ? { reason: unsupported } : {})
      })
      continue
    }

    /*
     * 符号链接、FIFO、设备节点一律**不列**。
     *
     * 符号链接可以指向项目外，甚至指回自己的父目录 —— 一条链接就足以让树无限
     * 展开。列出来又打不开，不如不列；真要支持它，得先有一套自己的环检测规则。
     */
  }

  return {
    ok: true,
    path: dirPath,
    entries: sortTreeEntries(entries, createNameCollator())
  }
}

/**
 * 文件为什么打不开；为 null 表示「能打开」。
 *
 * 分成两次判断：先看扩展名（纯逻辑，不需要碰盘），再按大小挡一次 ——
 * 一个 2 GB 的 .txt 在扩展名这一关是过得去的，读进来会把渲染进程拖死。
 */
async function fileUnsupportedReason(filePath: string): Promise<FileUnsupportedReason | null> {
  if (!isSupportedTextPath(filePath)) return 'not-text'

  try {
    const stats = await fs.stat(filePath)
    if (stats.size > MAX_TEXT_FILE_BYTES) return 'too-large'
  } catch (err) {
    logger.warn('Failed to stat a file while listing the tree', { file: filePath, error: err })
    return 'unreadable'
  }

  return null
}

/**
 * 读一个文本文件。
 *
 * 支持范围与树上的 supported 判断**共用同一套规则**（isSupportedTextPath）：
 * 树上标成支持的，这里就必须读得出来，否则用户会看到「点了却报不支持」。
 */
export async function readProjectFile(
  filePath: string,
  options: RootsOptions
): Promise<FileReadResult> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, reason: 'invalid-path' }
  }

  if (!isInsideAnyRoot(options.roots, filePath, options.caseInsensitive)) {
    logger.warn('Refused to read a file outside every known root', { file: filePath })
    return { ok: false, reason: 'outside-project' }
  }

  let stats: Stats
  try {
    stats = await fs.stat(filePath)
  } catch (err) {
    logger.warn('Failed to stat a file', { file: filePath, error: err })
    return { ok: false, reason: 'unreadable' }
  }

  if (!stats.isFile()) return { ok: false, reason: 'not-a-file' }
  if (stats.size > MAX_TEXT_FILE_BYTES) return { ok: false, reason: 'unreadable' }

  try {
    return { ok: true, path: filePath, content: await fs.readFile(filePath, 'utf-8') }
  } catch (err) {
    logger.warn('Failed to read a file', { file: filePath, error: err })
    return { ok: false, reason: 'unreadable' }
  }
}

/**
 * 在 `target` 所在的位置新建一个条目。
 *
 * 目标目录由 `target` 推导，两种情形：
 * - `target` 是目录 -> 建在**它内部**；
 * - `target` 是文件 -> 建在**它的同级**，只把最后一段换成新名字。
 *
 * 这是**第一处写盘**。三条约束一次说清：
 *
 * 1. **不覆盖任何东西。** 建文件用 `wx`（已存在就失败），建目录用不带 `recursive`
 *    的 `mkdir`（父目录不存在就失败）。同名文件的存在性由文件系统在同一个系统
 *    调用里判定，没有「先检查再写」那一段竞态，也就不需要为此写二次确认。
 * 2. **不跟着符号链接走。** 链接可以指向根之外，于是「在根内新建」会变成「在
 *    根外新建」。这里直接拒绝目标是链接的情形。
 * 3. **范围校验和读取完全一样**，逐段比对（见 isInsideProject）。
 *
 * 不校验扩展名：用户给新文件起什么名字是他的自由，宿主只决定**默认**补 `.md`
 * （见 shared/project 的 completeFileName）。不可打开的文件在树里点得动、
 * 只是进不了编辑器 —— 那正是「不支持」的表达方式。
 */
export async function createProjectEntry(
  request: CreateEntryRequest,
  options: RootsOptions
): Promise<CreateEntryResult> {
  const { kind, targetPath } = request

  const validation = validateEntryName(request.name)
  if (!validation.ok) return { ok: false, reason: 'invalid-name' }

  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return { ok: false, reason: 'unreadable' }
  }

  // 不接受相对路径：走到这里都是主进程给的绝对路径，收到别的说明调用方错了
  if (!path.isAbsolute(targetPath)) return { ok: false, reason: 'unreadable' }

  if (!isInsideAnyRoot(options.roots, targetPath, options.caseInsensitive)) {
    logger.warn('Refused to create an entry outside every known root', { target: targetPath })
    return { ok: false, reason: 'unreadable' }
  }

  let stats: Stats
  try {
    stats = await fs.lstat(targetPath)
  } catch (err) {
    logger.warn('Failed to stat the create target', { target: targetPath, error: err })
    return { ok: false, reason: 'unreadable' }
  }

  // 符号链接一律不碰：它可以把「根内新建」变成「根外新建」
  if (stats.isSymbolicLink()) {
    logger.warn('Refused to create an entry through a symbolic link', { target: targetPath })
    return { ok: false, reason: 'not-a-directory' }
  }

  /**
   * 目标目录：目录就进去，文件就落在它的同级。
   *
   * 用 `path.dirname` 而不是自己拼分隔符：这里拼出来的路径会被**原样返回**给渲染
   * 进程，而渲染进程要拿它去查 `children` 的 key —— 那些 key 是读取那一侧用
   * `path.join` 生成的。两边必须用同一套路径写法，否则新建出来的条目在树里查不到
   * 自己（Windows 上 `/` 与 `\` 混用就是这么来的）。
   */
  const isDir = stats.isDirectory()
  const parentDir = isDir ? targetPath : path.dirname(targetPath)
  const entryName = kind === 'file' ? completeFileName(validation.name) : validation.name
  const entryPath = path.join(parentDir, entryName)

  try {
    if (kind === 'file') {
      /**
       * `wx` = 只新建、已存在就报错。用 `writeFile` 而不是「先 exists 再 write」，
       * 因为中间那段时间刚好够别人把同名文件建出来 —— 那一步会把「不覆盖」这条
       * 承诺变成一个竞态。
       */
      await fs.writeFile(entryPath, '', { encoding: 'utf-8', flag: 'wx' })
    } else {
      // 不带 recursive：父目录不存在应当失败，而不是顺手建出一串中间目录
      await fs.mkdir(entryPath)
    }
  } catch (err) {
    return { ok: false, reason: classifyCreateError(err) }
  }

  logger.info('Project entry created', { kind, name: entryName })
  return { ok: true, path: entryPath, kind }
}

/**
 * 把 Node 的错误码翻成界面用语。
 *
 * `EEXIST` 是**预期内**的结果（用户起了个已经存在的名字），单列一类：界面要说的
 * 是「这个名字已经有了」，而不是「出错了」。权限与磁盘问题归到最后一类 ——
 * 它们和「位置不对」是两件事，文案也不该共用。
 */
function classifyCreateError(err: unknown): CreateEntryFailureReason {
  const code = (err as { code?: unknown } | null)?.code

  if (code === 'EEXIST') return 'already-exists'
  // 父目录不存在、父级其实是文件、或者名字已经被一个目录占着
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return 'not-a-directory'

  logger.warn('Failed to create an entry', { code, error: err })
  return 'unreadable'
}
