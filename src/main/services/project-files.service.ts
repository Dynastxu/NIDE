import fs from 'node:fs/promises'
import path from 'node:path'
import type { Dirent, Stats } from 'node:fs'
import {
  MAX_TEXT_FILE_BYTES,
  createNameCollator,
  filePathKey,
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
  DeleteEntryFailureReason,
  DeleteEntryRequest,
  DeleteEntryResult,
  DirReadResult,
  FileReadResult,
  FileTreeEntry,
  FileUnsupportedReason,
  RenameEntryFailureReason,
  RenameEntryRequest,
  RenameEntryResult
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
 * 不校验也不补扩展名：用户给新文件起什么名字，磁盘上就是什么名字。没有扩展名的
 * 文件在树里点得动、只是进不了编辑器 —— 那正是「不支持」的表达方式。
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
  const entryName = validation.name
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

// ============ 重命名 ============

/**
 * 给一个已存在的条目改名。
 *
 * 只换**最后一段**：目标目录就是 `targetPath` 自己所在的那一层，从它推出来 ——
 * 渲染进程报不出「移到哪儿」，所以重命名变不成一次搬移。这与新建的立场是同一条：
 * 写盘位置由主进程从被右键的条目推导，界面只出名字。
 *
 * 四条约束：
 *
 * 1. **不覆盖任何东西。** 落点已经存在时直接拒绝（见 resolveRenameTarget）；
 *    `fs.rename` 在 POSIX 上是**会静默覆盖**同名文件的，靠它自己拦不住。
 * 2. **名字走了与新建同一套校验**（validateEntryName）：空、含 `/`、以点开头、
 *    超长一律拒绝。两边共用一个函数，改名就不会比新建更宽松。
 * 3. **不跟着符号链接走。** 与新建同理：链接可以把「改根内的名字」变成
 *    「改根外某个东西的名字」。
 * 4. **范围校验与读写完全一样**（isInsideAnyRoot）。
 *
 * 文件与目录一视同仁：底下的 `fs.rename` 两者都吃，界面上也多不出第二种动作。
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

  // 与新建同理：走到这里都是主进程给过的绝对路径，收到别的说明调用方错了
  if (!path.isAbsolute(targetPath)) return { ok: false, reason: 'unreadable' }

  if (!isInsideAnyRoot(options.roots, targetPath, options.caseInsensitive)) {
    logger.warn('Refused to rename an entry outside every known root', { target: targetPath })
    return { ok: false, reason: 'unreadable' }
  }

  let stats: Stats
  try {
    stats = await fs.lstat(targetPath)
  } catch (err) {
    logger.warn('Failed to stat the rename target', { target: targetPath, error: err })
    return { ok: false, reason: 'not-a-file' }
  }

  if (stats.isSymbolicLink()) {
    logger.warn('Refused to rename a symbolic link', { target: targetPath })
    return { ok: false, reason: 'not-a-file' }
  }

  // 只认文件与目录：FIFO、设备节点这些既列不进树，也不该在这里被改名
  if (!stats.isDirectory() && !stats.isFile()) {
    logger.warn('Refused to rename an entry that is neither a file nor a directory', {
      target: targetPath
    })
    return { ok: false, reason: 'not-a-file' }
  }

  const kind: FileTreeEntry['kind'] = stats.isDirectory() ? 'directory' : 'file'
  const nextPath = path.join(path.dirname(targetPath), validation.name)

  const target = await resolveRenameTarget(targetPath, nextPath, validation.name, options)
  if (target === 'already-exists') return { ok: false, reason: 'already-exists' }
  // 同一个名字：什么都没发生，不必碰盘。**只在拼写完全一致时**才算数
  if (target === 'same') return { ok: true, path: targetPath, previousPath: targetPath, kind }

  try {
    if (target === 'case-change') await renameWithCaseChange(targetPath, nextPath)
    else await fs.rename(targetPath, nextPath)
  } catch (err) {
    logger.warn('Failed to rename an entry', { target: targetPath, code: renameErrorCode(err) })
    return { ok: false, reason: classifyRenameError(err) }
  }

  logger.info('Project entry renamed', { kind, target: path.basename(nextPath) })
  return { ok: true, path: nextPath, previousPath: targetPath, kind }
}

/** 这次重命名的落点该怎么处理：直接改 / 只改大小写 / 同名不动 / 已经有人占了 */
type RenameTargetDecision = 'rename' | 'case-change' | 'same' | 'already-exists'

/**
 * 落点有没有被别的条目占着。
 *
 * **不能拿 `lstat` 去问「这个路径存在吗」**：在大小写不敏感的文件系统上，
 * `lstat('CHAPTER.md')` 命中的就是 `Chapter.md` **自己** —— 于是「只改大小写」
 * 会被自己挡成 already-exists（这条曾经真的坏过）。
 *
 * 该问的是「这一层里有没有**字面**同名（含大小写）的条目」：那才是另一个条目。
 * 所以直接读目录拿名字比字符串，不碰路径解析。读一次目录的代价可以接受 ——
 * 改名本来就是用户手动触发、一次一个的动作。
 */
async function findLiteralEntries(dirPath: string, name: string): Promise<Dirent[]> {
  try {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true })
    return dirents.filter((dirent) => dirent.name === name)
  } catch (err) {
    // 读不了这一层：交给接下来的 rename 去报错，这里只说「没找到」
    logger.warn('Failed to list a directory while resolving a rename target', {
      dir: dirPath,
      error: err
    })
    return []
  }
}

/**
 * 决定落点怎么处理，以及**先问一句「那儿已经有东西了吗」**。
 *
 * 为什么要先问：`fs.rename` 在 POSIX 上会**静默覆盖**同名文件，在 Windows 上
 * 又会报 EEXIST —— 一个会毁掉用户稿子、另一个才是我们要的「绝不覆盖」。
 * 与其把结论押在平台语义上，不如自己判一次；之后那一步如果还是失败，说明
 * 有人在这中间抢先建了一个，落点会再报一次 EEXIST（见 classifyRenameError）。
 */
async function resolveRenameTarget(
  previousPath: string,
  nextPath: string,
  newName: string,
  options: RootsOptions
): Promise<RenameTargetDecision> {
  // 拼写完全一致：什么都没发生，不必碰盘
  if (newName === path.basename(previousPath)) return 'same'

  const literals = await findLiteralEntries(path.dirname(previousPath), newName)

  // 已经有一个**字面**同名的条目：绝不覆盖。若那就是源头自己，说明只是同一个名字
  if (literals.length > 0) {
    return literals.some((dirent) => dirent.name === path.basename(previousPath))
      ? 'same'
      : 'already-exists'
  }

  /**
   * 走到这里说明这一层没有任何字面同名的条目。剩下的情形里只有一种特殊：
   * **在大小写不敏感的文件系统上，落点其实还是它自己**（`第一章.MD` 与
   * `第一章.md` 是同一个条目）—— 直接 rename 会得到「源与目标是同一个东西」
   * 这种自相矛盾的操作，结果依平台而异，所以走一个中间名。
   *
   * 这个判断必须先确认平台语义：在大小写敏感的系统上，改成另一种大小写就是一个
   * 全新的文件名，那是普通的改名（上面已经确认没有冲突了）。
   */
  const onlyCaseDiffers =
    options.caseInsensitive && filePathKey(previousPath, true) === filePathKey(nextPath, true)

  return onlyCaseDiffers ? 'case-change' : 'rename'
}

/**
 * 只改大小写的改名，分两步走。
 *
 * Windows（以及 macOS 的默认卷）大小写不敏感：`第一章.MD` 与 `第一章.md` 是
 * **同一个**条目，直接 rename 会得到「源和目标是同一个东西」这种自相矛盾的结果，
 * 结果依平台而异。走一个中间名就没有这个问题。
 *
 * 第二步失败时**把原路径改回来**：宁可让用户看到一次失败，也不要留一个
 * `.nide-rename-…` 的临时名字在项目里 —— 那个名字他既没起过，也不会想到去找。
 */
async function renameWithCaseChange(previousPath: string, nextPath: string): Promise<void> {
  const parent = path.dirname(previousPath)
  // 前导点的名字走不过 validateEntryName，用户自己撞不上这个临时名
  const temporary = path.join(
    parent,
    `.nide-rename-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  )

  await fs.rename(previousPath, temporary)

  try {
    await fs.rename(temporary, nextPath)
  } catch (err) {
    try {
      await fs.rename(temporary, previousPath)
    } catch (rollbackError) {
      logger.error('Failed to restore the original name after a case-only rename', {
        target: previousPath,
        temporary,
        error: rollbackError
      })
    }
    throw err
  }
}

/**
 * 把 Node 的错误码翻成界面用语。
 *
 * `ENOTEMPTY` / `EEXIST` 都是**预期内**的结果（落点被占了），单列一类：
 * 界面要说的是「这个名字已经有了」，而不是「出错了」。
 */
function classifyRenameError(err: unknown): RenameEntryFailureReason {
  const code = renameErrorCode(err)

  if (code === 'EEXIST' || code === 'ENOTEMPTY') return 'already-exists'
  if (code === 'ENOENT') return 'not-a-file'

  return 'unreadable'
}

function renameErrorCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code
}

// ============ 删除 ============

/**
 * 删掉一个文件或目录。目录**连同里面的东西一起删**。
 *
 * 这是宿主唯一**不可撤销**的写盘动作，所以这里把能拒的都拒掉：
 *
 * 1. **项目根自己不能删。** 那是把整个项目从磁盘上抹掉，而树上的根那一行同样
 *    可以右键 —— 界面不提供这个入口，但边界必须在主进程（渲染进程能声明的只有
 *    一个路径）。判据用的是 `filePathKey`，Windows 上 `D:\Novel` 与 `d:\novel`
 *    是同一个根，不折叠大小写就会漏过去。
 * 2. **不跟着符号链接走。** 删链接本身无害，但 `fs.rm` 会顺着 `recursive` 走进
 *    链接指向的地方 —— 那可能是在项目之外。所以目标是链接时直接拒绝，与新建、
 *    重命名同一个立场。
 * 3. **范围校验与读写完全一样**（isInsideAnyRoot）。
 *
 * 不做「先读一遍确认它是空的」那类预检：`recursive + force` 一次就够，而 `force`
 * 顺带把「删到一半发现某个子项没权限」这类中途失败也交给文件系统报错。已经不存在
 * 的目标由 `force` 吞掉，结果是成功 —— 用户想要的那个状态已经在了。
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
    logger.warn('Refused to delete an entry outside every known root', { target: targetPath })
    return { ok: false, reason: 'unreadable' }
  }

  // 根自己：删掉它就是删掉整个项目
  const targetKey = filePathKey(targetPath, options.caseInsensitive)
  const isRoot = options.roots.some(
    (root) => root.length > 0 && filePathKey(root, options.caseInsensitive) === targetKey
  )
  if (isRoot) {
    logger.warn('Refused to delete a project root', { target: targetPath })
    return { ok: false, reason: 'is-project-root' }
  }

  let stats: Stats
  try {
    stats = await fs.lstat(targetPath)
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    // 已经没了：用户想要的状态就是「它不在了」，所以给成功而不是报错
    if (code === 'ENOENT') return { ok: true, path: targetPath, kind: null }

    logger.warn('Failed to stat the delete target', { target: targetPath, error: err })
    return { ok: false, reason: 'not-a-file' }
  }

  if (stats.isSymbolicLink()) {
    logger.warn('Refused to delete a symbolic link', { target: targetPath })
    return { ok: false, reason: 'not-a-file' }
  }

  if (!stats.isDirectory() && !stats.isFile()) {
    logger.warn('Refused to delete an entry that is neither a file nor a directory', {
      target: targetPath
    })
    return { ok: false, reason: 'not-a-file' }
  }

  const kind: FileTreeEntry['kind'] = stats.isDirectory() ? 'directory' : 'file'

  try {
    await fs.rm(targetPath, { recursive: true, force: true })
  } catch (err) {
    logger.warn('Failed to delete an entry', {
      target: targetPath,
      code: (err as { code?: unknown } | null)?.code
    })
    return { ok: false, reason: classifyDeleteError(err) }
  }

  logger.info('Project entry deleted', { kind, target: path.basename(targetPath) })
  return { ok: true, path: targetPath, kind }
}

/**
 * 把 Node 的错误码翻成界面用语。
 *
 * 删非空目录失败要单列一类：只有它对应的是「这个动作本身不能做」（而不是没权限），
 * 界面该说的是「这目录不是空的」，而不是「出错了」。宿主目前一律递归删，所以这码
 * 只在将来收紧成「只删空目录」时才会用到 —— 留着它，是因为翻译函数不该等着那件事发生。
 */
function classifyDeleteError(err: unknown): DeleteEntryFailureReason {
  const code = (err as { code?: unknown } | null)?.code

  if (code === 'ENOTEMPTY' || code === 'EEXIST') return 'not-empty'
  if (code === 'ENOENT') return 'not-a-file'

  return 'unreadable'
}
