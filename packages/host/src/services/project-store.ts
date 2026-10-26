import fs from 'node:fs'
import path from 'node:path'
import {
  PROJECTS_FILE_NAME,
  emptyProjectStore,
  normalizeProjectPath,
  parseProjectStore,
  projectNameFromPath,
  projectPathKey,
  removeProject,
  upsertProject
} from '../../../../src/shared/project/store.ts'
import type {
  ProjectListItem,
  ProjectRecord,
  ProjectStore
} from '../../../../src/shared/project/store.ts'

/**
 * 「打开过的项目」的**唯一**实现。
 *
 * 原本 Electron 主进程里还有一份（`src/main/services/project-store.ts`），两份各读
 * 一份 `projects.json`；现在只剩这一份，shell 通过 `project.*` RPC 调用它，自己不再
 * 落盘、也不再记「当前项目」。userData 目录由 shell 在 spawn 时传进来，所以这里
 * **不依赖 electron**。
 *
 * 日志暂时走 console：host 的日志出口还没有收到 ctx.logger 上。
 */

export type HostProjectOpenResult =
  | { ok: true; project: ProjectRecord }
  | { ok: false; reason: 'missing' | 'not-a-directory'; path?: string }

export class HostProjectStore {
  private store: ProjectStore | null = null
  private current: ProjectRecord | null = null
  private readonly userDataDir: string

  constructor(userDataDir: string) {
    this.userDataDir = userDataDir
  }

  private filePath(): string {
    return path.join(this.userDataDir, PROJECTS_FILE_NAME)
  }

  private caseInsensitive(): boolean {
    return process.platform === 'win32'
  }

  private readStore(): ProjectStore {
    try {
      const raw = fs.readFileSync(this.filePath(), 'utf-8')
      return parseProjectStore(JSON.parse(raw))
    } catch {
      // 首次启动（文件不存在）与文件损坏走同一条：空列表不是错误
      return emptyProjectStore()
    }
  }

  private persist(next: ProjectStore): void {
    this.store = next
    const target = this.filePath()
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
    } catch (error) {
      // 写不进去只影响「下次启动还记得」，不该让这次打开项目失败
      console.error('[nide-host] failed to write the project store', error)
    }
  }

  private ensureStore(): ProjectStore {
    if (!this.store) this.store = this.readStore()
    return this.store
  }

  private isDirectory(target: string): boolean {
    try {
      return fs.statSync(target).isDirectory()
    } catch {
      return false
    }
  }

  /** 列表 + 每条记录「目录还在不在」的结论。 */
  list(): ProjectListItem[] {
    // 每次重读：主进程可能刚打开 / 移除了一个项目，host 是常驻进程，缓存会过期。
    const store = this.readStore()
    this.store = store
    return store.projects.map((project) => ({
      ...project,
      missing: !this.isDirectory(project.path)
    }))
  }

  /** 当前打开的项目；host 启动时还没有打开任何项目。 */
  getCurrent(): ProjectRecord | null {
    return this.current
  }

  /**
   * 把当前项目同步成某个窗口绑定的项目。
   *
   * 换项目时主进程会重建窗口，但 host 是常驻的；新窗口在 port 建立后把
   * `--nide-project=` 里的路径送过来，这里只认**列表里已有**的记录，不新增。
   */
  setCurrent(dirPath: string): ProjectRecord | null {
    const normalized = normalizeProjectPath(dirPath)
    if (normalized.length === 0) {
      this.current = null
      return null
    }

    // 同样重读：打开新项目时主进程先写 projects.json，再重建窗口。
    const store = this.readStore()
    this.store = store

    const key = projectPathKey(normalized, this.caseInsensitive())
    const record = store.projects.find(
      (project) => projectPathKey(project.path, this.caseInsensitive()) === key
    )
    this.current = record ?? null
    return this.current
  }

  /**
   * 启动时该默认打开哪个项目。
   *
   * 只有「上次打开的那条记录存在、而且目录真的还在」才返回它；目录已经不在就
   * 返回 null。记录本身不删。
   */
  resolveStartup(): ProjectRecord | null {
    const loaded = this.ensureStore()
    if (!loaded.lastOpened) {
      this.current = null
      return null
    }

    const key = projectPathKey(loaded.lastOpened, this.caseInsensitive())
    const record = loaded.projects.find(
      (project) => projectPathKey(project.path, this.caseInsensitive()) === key
    )

    if (!record || !this.isDirectory(record.path)) {
      this.current = null
      return null
    }

    this.current = record
    console.info('[nide-host] resuming project', projectNameFromPath(record.path))
    return record
  }

  /** 打开一个目录作为当前项目：记进列表、落盘、记为当前。 */
  open(dirPath: string): HostProjectOpenResult {
    const normalized = normalizeProjectPath(dirPath)
    if (normalized.length === 0) return { ok: false, reason: 'missing' }

    let stats: fs.Stats
    try {
      stats = fs.statSync(normalized)
    } catch {
      return { ok: false, reason: 'missing', path: normalized }
    }

    if (!stats.isDirectory()) return { ok: false, reason: 'not-a-directory', path: normalized }

    const next = upsertProject(this.ensureStore(), normalized, {
      now: Date.now(),
      caseInsensitive: this.caseInsensitive()
    })
    this.persist(next)
    this.current = next.projects[0]
    // 只记名字，不记完整路径：路径里常常带用户名与项目名，日志没有理由抄一份
    console.info('[nide-host] project opened', projectNameFromPath(this.current.path))
    return { ok: true, project: this.current }
  }

  /** 从列表里移除一条记录。磁盘上的目录不动。 */
  forget(dirPath: string): void {
    const next = removeProject(this.ensureStore(), dirPath, {
      caseInsensitive: this.caseInsensitive()
    })
    if (next === this.ensureStore()) return

    this.persist(next)
    if (
      this.current &&
      projectPathKey(this.current.path, this.caseInsensitive()) ===
        projectPathKey(dirPath, this.caseInsensitive())
    ) {
      this.current = null
    }

    console.info('[nide-host] project removed from the list', projectNameFromPath(dirPath))
  }

  /** 关闭当前项目：回到「没有项目」的状态，不动列表与 lastOpened。 */
  close(): void {
    if (!this.current) return

    console.info('[nide-host] project closed', projectNameFromPath(this.current.path))
    this.current = null
  }
}
