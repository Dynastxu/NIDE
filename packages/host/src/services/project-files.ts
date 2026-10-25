import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent, Stats } from 'node:fs'
import {
  HOST_TEMP_FILE_PREFIX,
  MAX_TEXT_FILE_BYTES,
  createNameCollator,
  isHostTempFileName,
  isIgnoredDirectoryName,
  isInsideProject,
  isSupportedTextPath,
  sortTreeEntries
} from '../../../../src/shared/project/files.ts'
import type {
  DirReadFailureReason,
  DirReadResult,
  FileReadResult,
  FileTreeEntry,
  FileUnsupportedReason,
  FileWriteFailureReason,
  FileWriteResult,
  WriteFileRequest
} from '../../../../src/shared/project/files.ts'

/**
 * 项目文件读取（host 侧 MVP）。
 *
 * 只搬了 `readDir` 与 `readFile` 两条读路径；新建 / 改名 / 删除 / 保存仍在
 * Electron 主进程（阶段 2 后续再搬）。纯逻辑（支持的扩展名、忽略目录、排序、
 * 是否在项目根内）全部复用 `src/shared/project/files.ts`，这里只保留碰盘的那一半。
 *
 * TODO:
 * - 和 `src/main/services/project-files.service.ts` 合并成一份，删掉重复
 * - 把 logger 换成 ctx.logger
 * - 写路径（create/rename/delete/write）搬过来
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
