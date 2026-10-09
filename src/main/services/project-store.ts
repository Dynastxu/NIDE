import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  PROJECTS_FILE_NAME,
  emptyProjectStore,
  normalizeProjectPath,
  parseProjectStore,
  projectNameFromPath,
  projectPathKey,
  removeProject,
  upsertProject
} from '@shared/project'
import { loggerFor } from '../logger'
import type {
  ProjectListItem,
  ProjectOpenResult,
  ProjectRecord,
  ProjectStore
} from '@shared/project'

const logger = loggerFor('project')

/**
 * 「打开过的项目」的持久化。
 *
 * 落盘位置和语言偏好（src/main/i18n/preference.ts）一样选 userData，而不是渲染
 * 进程的 localStorage：主进程在**建窗之前**就要知道这次该开哪个窗口、窗口标题写
 * 什么，而 localStorage 在渲染进程里，主进程读不到。
 *
 * 文件里只有路径与时间戳，没有任何项目内容 —— 应用从项目目录里读什么、写什么，
 * 是后续的事，这个文件不该成为那件事的入口。
 */

/** 内存镜像。启动时读一次，之后写盘顺手更新 */
let store: ProjectStore | null = null

/** 当前打开的项目。null 表示没有项目（欢迎窗口那种状态） */
let current: ProjectRecord | null = null

function filePath(): string {
  return path.join(app.getPath('userData'), PROJECTS_FILE_NAME)
}

/**
 * 路径比较是否忽略大小写。
 *
 * 只在主进程判断：`process.platform` 在渲染进程里不是完整的，而这个结论要经
 * shared 的纯函数使用，所以由调用方把结论传进去（见 shared/project 的说明）。
 */
function caseInsensitive(): boolean {
  return process.platform === 'win32'
}

function readStore(): ProjectStore {
  try {
    const raw = fs.readFileSync(filePath(), 'utf-8')
    return parseProjectStore(JSON.parse(raw))
  } catch {
    // 首次启动（文件不存在）与文件损坏走同一条：空列表不是错误，
    // 界面会落到欢迎窗口，用户重新选一次即可
    return emptyProjectStore()
  }
}

function persist(next: ProjectStore): void {
  store = next

  const target = filePath()
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
  } catch (err) {
    // 写不进去只影响「下次启动还记得」，不该让这次打开项目失败
    logger.error('Failed to write the project store', { error: err })
  }
}

function ensureStore(): ProjectStore {
  if (!store) {
    store = readStore()
    logger.info('Project store loaded', { count: store.projects.length })
  }
  return store
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** 列表 + 每条记录「目录还在不在」的结论 */
export function getProjectList(): ProjectListItem[] {
  return ensureStore().projects.map((project) => ({
    ...project,
    missing: !isDirectory(project.path)
  }))
}

/** 当前打开的项目。主窗口的标题、启动参数都用它 */
export function getCurrentProject(): ProjectRecord | null {
  return current
}

/**
 * 启动时该默认打开哪个项目。
 *
 * 只有「上次打开的那条记录存在、而且它的目录真的还在」才返回它；目录已经不在了
 * （被删、改名、外接盘没插）就返回 null —— 调用方据此开欢迎窗口，让用户重新选。
 * 记录本身**不删**：一块没插上的盘不该让用户丢掉列表里的一行。
 */
export function resolveStartupProject(): ProjectRecord | null {
  const loaded = ensureStore()
  if (!loaded.lastOpened) {
    current = null
    return null
  }

  const key = projectPathKey(loaded.lastOpened, caseInsensitive())
  const record = loaded.projects.find((p) => projectPathKey(p.path, caseInsensitive()) === key)

  if (!record || !isDirectory(record.path)) {
    logger.warn('The last opened project is not available', {
      name: projectNameFromPath(loaded.lastOpened)
    })
    current = null
    return null
  }

  current = record
  // 只记名字，不记完整路径：路径里常常带用户名与项目名，日志没有理由抄一份
  logger.info('Resuming the last opened project', { name: projectNameFromPath(record.path) })
  return record
}

/**
 * 打开一个目录作为当前项目：记进列表、落盘、记为当前。
 *
 * 只做状态与磁盘记录这一半，「把哪个窗口开出来」留在 IPC 层 —— 这个模块不认识窗口。
 */
export function openProject(dirPath: string): ProjectOpenResult {
  const normalized = normalizeProjectPath(dirPath)
  if (normalized.length === 0) return { ok: false, reason: 'missing' }

  let stats: fs.Stats
  try {
    stats = fs.statSync(normalized)
  } catch {
    return { ok: false, reason: 'missing', path: normalized }
  }

  if (!stats.isDirectory()) return { ok: false, reason: 'not-a-directory', path: normalized }

  const next = upsertProject(ensureStore(), normalized, {
    now: Date.now(),
    caseInsensitive: caseInsensitive()
  })
  persist(next)

  // upsertProject 把这次打开的记录放在最前面，所以第一项就是它
  const project = next.projects[0]
  current = project

  logger.info('Project opened', { name: projectNameFromPath(project.path) })
  return { ok: true, project }
}

/** 从列表里移除一条记录。磁盘上的目录不动 */
export function forgetProject(dirPath: string): void {
  const next = removeProject(ensureStore(), dirPath, { caseInsensitive: caseInsensitive() })
  if (next === ensureStore()) return

  persist(next)
  if (
    current &&
    projectPathKey(current.path, caseInsensitive()) === projectPathKey(dirPath, caseInsensitive())
  ) {
    current = null
  }

  logger.info('Project removed from the list', { name: projectNameFromPath(dirPath) })
}

/**
 * 关闭当前项目：回到「没有项目」的状态，**不动**列表与 lastOpened。
 *
 * 与 `forgetProject` 的区别是这件事只影响这次会话：记录仍留在「打开过的项目」里，
 * 下次启动照样默认打开它。
 */
export function closeProject(): void {
  if (!current) return

  logger.info('Project closed', { name: projectNameFromPath(current.path) })
  current = null
}
