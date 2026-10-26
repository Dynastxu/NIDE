import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent, Stats } from 'node:fs'
import {
  HOST_TEMP_FILE_PREFIX,
  MAX_TEXT_FILE_BYTES,
  createNameCollator,
  filePathKey,
  isHostTempFileName,
  isIgnoredDirectoryName,
  isInsideProject,
  isSupportedTextPath,
  sortTreeEntries,
  validateEntryName
} from '../../../../src/shared/project/files.ts'
import type {
  CreateEntryFailureReason,
  CreateEntryRequest,
  CreateEntryResult,
  DeleteEntryFailureReason,
  DeleteEntryRequest,
  DeleteEntryResult,
  DirReadFailureReason,
  DirReadResult,
  FileReadResult,
  FileTreeEntry,
  FileUnsupportedReason,
  FileWriteFailureReason,
  FileWriteResult,
  RenameEntryFailureReason,
  RenameEntryRequest,
  RenameEntryResult,
  WriteFileRequest
} from '../../../../src/shared/project/files.ts'

/**
 * 项目文件读写（host 侧）。
 *
 * 读：`readDir` / `readFile`；写：`writeFile` / `createEntry` / `renameEntry` /
 * `deleteEntry`。纯逻辑（支持的扩展名、忽略目录、排序、名字校验、是否在项目根内）
 * 全部复用 `src/shared/project/files.ts`，这里只保留碰盘的那一半。
 *
 * 保留 `src/main/services/project-files.service.ts` 是为了回退：preload 走 host
 * 优先，失败时仍回到旧 IPC。等所有读写路径都在 host 上验证过之后再删那一份。
 *
 * TODO:
 * - 和主进程那份合并成一份，删掉重复实现与旧 handler
 * - 把 logger 换成 ctx.logger
 * - rename 之后的概述映射（`.nide/config.yml`）仍在 shell：配置服务还没搬
 */

export interface RootsOptions {
  /** 允许访问的根目录集合；MVP 只有当前项目一个。 */
  roots: readonly string[]
  /** 路径比较是否忽略大小写；由调用方按平台给。 */
  caseInsensitive: boolean
}

function isInsideAnyRoot(
  roots: readonly string[],
  target: string,
  caseInsensitive: boolean
): boolean {
  return roots.some((root) => root.length > 0 && isInsideProject(root, target, caseInsensitive))
}

function classifyReadError(error: unknown): DirReadFailureReason {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'not-a-directory'
  return 'unreadable'
}

async function fileUnsupportedReason(filePath: string): Promise<FileUnsupportedReason | null> {
  if (!isSupportedTextPath(filePath)) return 'not-text'

  try {
    const stats = await fs.stat(filePath)
    if (stats.size > MAX_TEXT_FILE_BYTES) return 'too-large'
  } catch {
    return 'unreadable'
  }

  return null
}

/** 读一层目录（不递归）。 */
export async function readProjectDir(
  dirPath: string,
  options: RootsOptions
): Promise<DirReadResult> {
  if (typeof dirPath !== 'string' || dirPath.length === 0) {
    return { ok: false, reason: 'invalid-path' }
  }

  if (!isInsideAnyRoot(options.roots, dirPath, options.caseInsensitive)) {
    return { ok: false, reason: 'outside-project' }
  }

  let dirents: Dirent[]
  try {
    dirents = await fs.readdir(dirPath, { withFileTypes: true })
  } catch (error) {
    console.warn('[nide-host] failed to read a directory', { dir: dirPath, error })
    return { ok: false, reason: classifyReadError(error) }
  }

  const entries: FileTreeEntry[] = []

  for (const dirent of dirents) {
    const entryPath = path.join(dirPath, dirent.name)

    if (dirent.isDirectory()) {
      if (isIgnoredDirectoryName(dirent.name)) continue
      entries.push({ kind: 'directory', path: entryPath, name: dirent.name })
      continue
    }

    if (dirent.isFile()) {
      if (isHostTempFileName(dirent.name)) continue

      const unsupported = await fileUnsupportedReason(entryPath)
      entries.push({
        kind: 'file',
        path: entryPath,
        name: dirent.name,
        supported: unsupported === null,
        ...(unsupported ? { reason: unsupported } : {})
      })
    }
  }

  return {
    ok: true,
    path: dirPath,
    entries: sortTreeEntries(entries, createNameCollator())
  }
}

/** 读一个纯文本 / Markdown 文件。 */
export async function readProjectFile(
  filePath: string,
  options: RootsOptions
): Promise<FileReadResult> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, reason: 'invalid-path' }
  }

  if (!isInsideAnyRoot(options.roots, filePath, options.caseInsensitive)) {
    return { ok: false, reason: 'outside-project' }
  }

  let stats: Stats
  try {
    stats = await fs.stat(filePath)
  } catch (error) {
    console.warn('[nide-host] failed to stat a file', { file: filePath, error })
    return { ok: false, reason: 'unreadable' }
  }

  if (!stats.isFile()) return { ok: false, reason: 'not-a-file' }
  if (stats.size > MAX_TEXT_FILE_BYTES) return { ok: false, reason: 'unreadable' }

  try {
    return { ok: true, path: filePath, content: await fs.readFile(filePath, 'utf-8') }
  } catch (error) {
    console.warn('[nide-host] failed to read a file', { file: filePath, error })
    return { ok: false, reason: 'unreadable' }
  }
}

function temporaryName(scope: string): string {
  return `${HOST_TEMP_FILE_PREFIX}${scope}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

function classifyWriteError(error: unknown): FileWriteFailureReason {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return 'not-a-file'
  if (code === 'ENOSPC') return 'too-large'
  return 'unreadable'
}

/**
 * 把正文写回一个**已经存在**的文件（保存）。
 *
 * 与主进程那份实现同语义：只写项目内、只写普通文件、不碰符号链接、只写宿主编解码
 * 得出来的格式；落盘走「同目录临时件 + 原子 rename」。
 */
export async function writeProjectFile(
  request: WriteFileRequest,
  options: RootsOptions
): Promise<FileWriteResult> {
  const { filePath } = request

  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, reason: 'invalid-path' }
  }

  if (typeof request.content !== 'string') {
    return { ok: false, reason: 'invalid-path' }
  }

  if (!path.isAbsolute(filePath)) return { ok: false, reason: 'invalid-path' }

  if (!isInsideAnyRoot(options.roots, filePath, options.caseInsensitive)) {
    return { ok: false, reason: 'outside-project' }
  }

  let stats: Stats
  try {
    stats = await fs.lstat(filePath)
  } catch {
    return { ok: false, reason: 'not-a-file' }
  }

  if (stats.isSymbolicLink()) return { ok: false, reason: 'not-a-file' }
  if (!stats.isFile()) return { ok: false, reason: 'not-a-file' }
  if (!isSupportedTextPath(filePath)) return { ok: false, reason: 'not-text' }
  if (Buffer.byteLength(request.content, 'utf-8') > MAX_TEXT_FILE_BYTES) {
    return { ok: false, reason: 'too-large' }
  }

  const temporary = path.join(path.dirname(filePath), temporaryName('save'))

  try {
    await fs.writeFile(temporary, request.content, { encoding: 'utf-8', flag: 'wx' })
    await fs.rename(temporary, filePath)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
    return { ok: false, reason: classifyWriteError(error) }
  }

  console.info('[nide-host] project file saved', { file: path.basename(filePath) })
  return { ok: true, path: filePath }
}

// ============ 新建 ============

function classifyCreateError(error: unknown): CreateEntryFailureReason {
  const code = (error as { code?: unknown } | null)?.code

  // EEXIST 是预期内的结果（用户起了个已经存在的名字），不是故障
  if (code === 'EEXIST') return 'already-exists'
  // 父目录不存在、父级其实是文件、或者名字已经被一个目录占着
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return 'not-a-directory'

  console.warn('[nide-host] failed to create an entry', { code, error })
  return 'unreadable'
}

/**
 * 在 `targetPath` 所在的位置新建一个条目。
 *
 * `targetPath` 是用户右键的那个条目：目录 -> 建在它内部，文件 -> 建在它的同级。
 * 目标目录由这里从 targetPath 推导，调用方指定不了任意写入位置。
 *
 * 三条约束与读取共用同一条边界：范围校验（isInsideProject）、绝对路径、
 * 不跟着符号链接走。另外**绝不覆盖**：文件用 `wx`，目录用不带 `recursive` 的
 * `mkdir` —— 同名判定与创建在同一次系统调用里完成，没有「先检查再写」的竞态。
 */
export async function createProjectEntry(
  request: CreateEntryRequest,
  options: RootsOptions
): Promise<CreateEntryResult> {
  const { kind, targetPath } = request

  const validation = validateEntryName(request.name)
  if (!validation.ok) return { ok: false, reason: 'invalid-name' }

  // 给目录传初始内容说明调用方对「自己在建什么」的理解与这里不一致：拒绝而不是忽略
  if (request.content !== undefined && kind !== 'file') {
    console.warn('[nide-host] refused to create a directory with initial content', {
      target: targetPath
    })
    return { ok: false, reason: 'not-a-directory' }
  }

  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return { ok: false, reason: 'unreadable' }
  }

  if (!path.isAbsolute(targetPath)) return { ok: false, reason: 'unreadable' }

  if (!isInsideAnyRoot(options.roots, targetPath, options.caseInsensitive)) {
    console.warn('[nide-host] refused to create an entry outside every known root', {
      target: targetPath
    })
    return { ok: false, reason: 'unreadable' }
  }

  let stats: Stats
  try {
    stats = await fs.lstat(targetPath)
  } catch (error) {
    console.warn('[nide-host] failed to stat the create target', { target: targetPath, error })
    return { ok: false, reason: 'unreadable' }
  }

  // 符号链接一律不碰：它可以把「根内新建」变成「根外新建」
  if (stats.isSymbolicLink()) {
    console.warn('[nide-host] refused to create an entry through a symbolic link', {
      target: targetPath
    })
    return { ok: false, reason: 'not-a-directory' }
  }

  /**
   * 用 `path.dirname` 而不是自己拼分隔符：返回的路径会被渲染进程拿去查 `children`
   * 的 key，而那些 key 是读取那一侧用 `path.join` 生成的，两边必须同一套写法。
   */
  const parentDir = stats.isDirectory() ? targetPath : path.dirname(targetPath)
  const entryName = validation.name
  const entryPath = path.join(parentDir, entryName)

  try {
    if (kind === 'file') {
      // 初始内容与文件在同一次调用里落盘：分两次写会留下「建好了但还没内容」的中间态
      await fs.writeFile(entryPath, request.content ?? '', { encoding: 'utf-8', flag: 'wx' })
    } else {
      // 不带 recursive：父目录不存在应当失败，而不是顺手建出一串中间目录
      await fs.mkdir(entryPath)
    }
  } catch (error) {
    return { ok: false, reason: classifyCreateError(error) }
  }

  console.info('[nide-host] project entry created', { kind, name: entryName })
  return { ok: true, path: entryPath, kind }
}

// ============ 重命名 ============

/** 这次重命名的落点该怎么处理：直接改 / 只改大小写 / 同名不动 / 已经有人占了 */
type RenameTargetDecision = 'rename' | 'case-change' | 'same' | 'already-exists'

/**
 * 落点有没有被别的条目占着。
 *
 * 不能拿 `lstat` 去问「这个路径存在吗」：在大小写不敏感的文件系统上，`lstat` 命中的
 * 可能就是条目自己。该问的是「这一层里有没有**字面**同名（含大小写）的条目」。
 */
async function findLiteralEntries(dirPath: string, name: string): Promise<Dirent[]> {
  try {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true })
    return dirents.filter((dirent) => dirent.name === name)
  } catch (error) {
    // 读不了这一层：交给接下来的 rename 去报错，这里只说「没找到」
    console.warn('[nide-host] failed to list a directory while resolving a rename target', {
      dir: dirPath,
      error
    })
    return []
  }
}

async function resolveRenameTarget(
  previousPath: string,
  nextPath: string,
  newName: string,
  options: RootsOptions
): Promise<RenameTargetDecision> {
  // 拼写完全一致：什么都没发生，不必碰盘
  if (newName === path.basename(previousPath)) return 'same'

  const literals = await findLiteralEntries(path.dirname(previousPath), newName)

  if (literals.length > 0) {
    return literals.some((dirent) => dirent.name === path.basename(previousPath))
      ? 'same'
      : 'already-exists'
  }

  /**
   * 大小写不敏感的文件系统上，落点其实还是它自己（`第一章.MD` 与 `第一章.md` 是同一个
   * 条目）—— 直接 rename 会得到「源与目标是同一个东西」，所以走一个中间名。
   */
  const onlyCaseDiffers =
    options.caseInsensitive && filePathKey(previousPath, true) === filePathKey(nextPath, true)

  return onlyCaseDiffers ? 'case-change' : 'rename'
}

/**
 * 只改大小写的改名，分两步走。
 *
 * 第二步失败时把原路径改回来：宁可让用户看到一次失败，也不要留一个
 * `.nide-rename-…` 的临时名字在项目里。
 */
async function renameWithCaseChange(previousPath: string, nextPath: string): Promise<void> {
  const temporary = path.join(path.dirname(previousPath), temporaryName('rename'))

  await fs.rename(previousPath, temporary)

  try {
    await fs.rename(temporary, nextPath)
  } catch (error) {
    try {
      await fs.rename(temporary, previousPath)
    } catch (rollbackError) {
      console.error('[nide-host] failed to restore the original name after a case-only rename', {
        target: previousPath,
        temporary,
        error: rollbackError
      })
    }
    throw error
  }
}

function renameErrorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code
}

function classifyRenameError(error: unknown): RenameEntryFailureReason {
  const code = renameErrorCode(error)

  // EEXIST / ENOTEMPTY 都是预期内：落点被占了，界面要说「这个名字已经有了」
  if (code === 'EEXIST' || code === 'ENOTEMPTY') return 'already-exists'
  if (code === 'ENOENT') return 'not-a-file'

  return 'unreadable'
}

/**
 * 给一个已存在的条目改名。
 *
 * 只换最后一段：目标目录从 targetPath 自己推出来，所以重命名变不成一次搬移。
 * 绝不覆盖（先自己判一次落点，`fs.rename` 在 POSIX 上会静默覆盖）、不跟着符号链接走、
 * 名字走与新建同一套校验、范围校验与读写完全一样。
 */
export async function renameProjectEntry(
  request: RenameEntryRequest,
  options: RootsOptions
): Promise<RenameEntryResult> {
  const { targetPath } = request

  const validation = validateEntryName(request.name)
  if (!validation.ok) return { ok: false, reason: 'invalid-name' }

  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return { ok: false, reason: 'unreadable' }
  }

  if (!path.isAbsolute(targetPath)) return { ok: false, reason: 'unreadable' }

  if (!isInsideAnyRoot(options.roots, targetPath, options.caseInsensitive)) {
    console.warn('[nide-host] refused to rename an entry outside every known root', {
      target: targetPath
    })
    return { ok: false, reason: 'unreadable' }
  }

  let stats: Stats
  try {
    stats = await fs.lstat(targetPath)
  } catch (error) {
    console.warn('[nide-host] failed to stat the rename target', { target: targetPath, error })
    return { ok: false, reason: 'not-a-file' }
  }

  if (stats.isSymbolicLink()) {
    console.warn('[nide-host] refused to rename a symbolic link', { target: targetPath })
    return { ok: false, reason: 'not-a-file' }
  }

  // 只认文件与目录：FIFO、设备节点这些既列不进树，也不该在这里被改名
  if (!stats.isDirectory() && !stats.isFile()) {
    console.warn('[nide-host] refused to rename an entry that is neither a file nor a directory', {
      target: targetPath
    })
    return { ok: false, reason: 'not-a-file' }
  }

  const kind: FileTreeEntry['kind'] = stats.isDirectory() ? 'directory' : 'file'
  const nextPath = path.join(path.dirname(targetPath), validation.name)

  const target = await resolveRenameTarget(targetPath, nextPath, validation.name, options)
  if (target === 'already-exists') return { ok: false, reason: 'already-exists' }
  // 同一个名字：什么都没发生，不必碰盘。只在拼写完全一致时才算数
  if (target === 'same') return { ok: true, path: targetPath, previousPath: targetPath, kind }

  try {
    if (target === 'case-change') await renameWithCaseChange(targetPath, nextPath)
    else await fs.rename(targetPath, nextPath)
  } catch (error) {
    console.warn('[nide-host] failed to rename an entry', {
      target: targetPath,
      code: renameErrorCode(error)
    })
    return { ok: false, reason: classifyRenameError(error) }
  }

  console.info('[nide-host] project entry renamed', { kind, target: path.basename(nextPath) })
  return { ok: true, path: nextPath, previousPath: targetPath, kind }
}

// ============ 删除 ============

/**
 * 删掉一个文件或目录。目录**连同里面的东西一起删**。
 *
 * 这是唯一不可撤销的写盘动作，所以能拒的都拒掉：
 * 1. 项目根自己不能删（`filePathKey` 折叠大小写，Windows 上 `D:\Novel` 与 `d:\novel`
 *    是同一个根）；
 * 2. 不跟着符号链接走（`fs.rm` 的 recursive 会走进链接指向的地方）；
 * 3. 范围校验与读写完全一样。
 *
 * 已经不存在时返回成功（`kind: null`）：用户想要的那个状态已经成立。
 */
export async function deleteProjectEntry(
  request: DeleteEntryRequest,
  options: RootsOptions
): Promise<DeleteEntryResult> {
  const { targetPath } = request

  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    return { ok: false, reason: 'unreadable' }
  }

  if (!path.isAbsolute(targetPath)) return { ok: false, reason: 'unreadable' }

  if (!isInsideAnyRoot(options.roots, targetPath, options.caseInsensitive)) {
    console.warn('[nide-host] refused to delete an entry outside every known root', {
      target: targetPath
    })
    return { ok: false, reason: 'unreadable' }
  }

  // 根自己：删掉它就是删掉整个项目
  const targetKey = filePathKey(targetPath, options.caseInsensitive)
  const isRoot = options.roots.some(
    (root) => root.length > 0 && filePathKey(root, options.caseInsensitive) === targetKey
  )
  if (isRoot) {
    console.warn('[nide-host] refused to delete a project root', { target: targetPath })
    return { ok: false, reason: 'is-project-root' }
  }

  let stats: Stats
  try {
    stats = await fs.lstat(targetPath)
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'ENOENT') return { ok: true, path: targetPath, kind: null }

    console.warn('[nide-host] failed to stat the delete target', { target: targetPath, error })
    return { ok: false, reason: 'not-a-file' }
  }

  if (stats.isSymbolicLink()) {
    console.warn('[nide-host] refused to delete a symbolic link', { target: targetPath })
    return { ok: false, reason: 'not-a-file' }
  }

  if (!stats.isDirectory() && !stats.isFile()) {
    console.warn('[nide-host] refused to delete an entry that is neither a file nor a directory', {
      target: targetPath
    })
    return { ok: false, reason: 'not-a-file' }
  }

  const kind: FileTreeEntry['kind'] = stats.isDirectory() ? 'directory' : 'file'

  try {
    await fs.rm(targetPath, { recursive: true, force: true })
  } catch (error) {
    console.warn('[nide-host] failed to delete an entry', {
      target: targetPath,
      code: (error as { code?: unknown } | null)?.code
    })
    return { ok: false, reason: classifyDeleteError(error) }
  }

  console.info('[nide-host] project entry deleted', { kind, target: path.basename(targetPath) })
  return { ok: true, path: targetPath, kind }
}

function classifyDeleteError(error: unknown): DeleteEntryFailureReason {
  const code = (error as { code?: unknown } | null)?.code

  if (code === 'ENOTEMPTY' || code === 'EEXIST') return 'not-empty'
  if (code === 'ENOENT') return 'not-a-file'

  return 'unreadable'
}
