/**
 * 项目契约：打开过的文件夹、当前项目、以及跨进程的 IPC 通道名。
 *
 * 这一层被主进程、preload、渲染进程三方共用，所以**不能** import electron / fs / DOM。
 * 「列表怎么增删、坏文件怎么降级」这类规则写在这里的纯函数里，落盘与目录检查留在
 * 主进程（`src/main/services/project-store.ts`）—— 那样这些规则可以单独测，
 * 不需要起 electron。
 *
 * 文件树（目录条目、排序、支持哪些文本格式、新建时的名字校验）在 `./files`，
 * 同样只放纯逻辑。
 */

export * from './files'
export * from './tree'

/**
 * 项目 = 一个文件夹。
 *
 * 宿主不往项目里放**自己的**东西（没有项目文件、没有配置目录），所以「项目」的身份
 * 就是目录路径本身；名字每次从路径推导，不落盘 —— 目录被改名后，落盘的名字会变成
 * 一个更明显的谎。
 *
 * 唯一的例外是用户在界面上主动新建文件 / 文件夹（见 ./files 的 CreateEntryRequest）：
 * 那是往项目里写**用户的**东西，只增不改、不覆盖。
 */
export interface ProjectRecord {
  /** 目录的绝对路径（已去掉末尾分隔符） */
  path: string
  /** 最近一次打开的时间戳（毫秒）。列表按它倒序 */
  openedAt: number
}

/** 项目在界面上的形状：多一个「目录还在不在」的结论 */
export interface ProjectListItem extends ProjectRecord {
  /**
   * 目录已经不存在（被删、改名，或者所在磁盘 / 网络位置当前不可用）。
   *
   * 只在读取时算，**不落盘、也不自动清理**：外接盘没插、网络盘断线都会让一个
   * 正常项目暂时查不到，那时把记录删掉等于替用户做了不可撤销的决定。
   */
  missing: boolean
}

/** 落盘的整体形状 */
export interface ProjectStore {
  version: number
  /** 上次打开的项目路径；启动时优先打开它 */
  lastOpened: string | null
  /** 打开过的项目，按 openedAt 倒序 */
  projects: ProjectRecord[]
}

export const PROJECT_STORE_VERSION = 1

/** 落盘文件名（放在 userData 下） */
export const PROJECTS_FILE_NAME = 'projects.json'

/**
 * 列表长度上限。
 *
 * 这份列表是人手动攒出来的，不该无限增长；超出后丢掉最久没打开的记录 ——
 * 被丢掉的只是「最近列表」里的一条，项目本身在磁盘上一点没动。
 */
export const MAX_PROJECTS = 50

/**
 * 启动参数前缀：主进程建窗时把**当前项目路径**喂进渲染进程。
 *
 * 和 locale / 窗口种类 / 日志级别一样走启动参数而不是 IPC：标题栏第一帧就要显示
 * 项目名，异步取会先渲染一版没有项目名的标题再跳一下。
 */
export const PROJECT_ARG_PREFIX = '--nide-project='

export function emptyProjectStore(): ProjectStore {
  return { version: PROJECT_STORE_VERSION, lastOpened: null, projects: [] }
}

/**
 * 规范化一个目录路径：去掉首尾空白与末尾分隔符。
 *
 * 末尾分隔符必须去掉，否则 `D:\Novel` 与 `D:\Novel\` 会被当成两个项目，
 * 列表里出现两条一模一样的记录。根目录（`/`、`C:\`）去掉之后会剩下 `C:` 这种
 * 半截路径，所以对根做一次保护：只剩下盘符或什么都不剩时保留原样。
 */
export function normalizeProjectPath(raw: string): string {
  const trimmed = String(raw ?? '').trim()
  if (trimmed.length === 0) return ''

  const stripped = trimmed.replace(/[\\/]+$/, '')
  // `C:\` -> `C:` / `/` -> `` —— 这两种都不是可用的路径，保留原样
  if (stripped.length === 0 || /^[a-zA-Z]:$/.test(stripped)) return trimmed

  return stripped
}

/**
 * 从路径推导显示用的项目名（最后一个路径段）。
 *
 * 推不出来时（根目录那类）回落成整条路径：宁可显示得长一点，也不要显示空白。
 */
export function projectNameFromPath(raw: string): string {
  const normalized = normalizeProjectPath(raw)
  const segment = normalized.split(/[\\/]/).filter(Boolean).pop()
  return segment ?? normalized
}

/**
 * 用于比较两个路径是否指向同一个项目。
 *
 * 是否忽略大小写由调用方决定，**不能**在这里读 `process.platform`：这一层也被
 * 渲染进程用，而渲染进程里没有完整的 `process`。主进程传 `win32` 的判断结果进来。
 */
export function projectPathKey(raw: string, caseInsensitive: boolean): string {
  const normalized = normalizeProjectPath(raw)
  return caseInsensitive ? normalized.toLowerCase() : normalized
}

function validRecord(value: unknown): ProjectRecord | null {
  if (!value || typeof value !== 'object') return null

  const { path: dirPath, openedAt } = value as { path?: unknown; openedAt?: unknown }
  if (typeof dirPath !== 'string') return null

  const normalized = normalizeProjectPath(dirPath)
  if (normalized.length === 0) return null

  return {
    path: normalized,
    // 时间戳缺失或坏掉时给 0：这条记录排到最后，但不会因此丢掉
    openedAt: typeof openedAt === 'number' && Number.isFinite(openedAt) ? openedAt : 0
  }
}

/**
 * 把磁盘上的任意 JSON 收敛成一份可用的 store。
 *
 * 三个刻意的选择：
 * - **坏数据不抛异常。** 文件损坏 / 版本不认识时返回空 store，应用照常进欢迎窗口；
 *   崩溃或白屏换不来任何好处。
 * - **逐条校验而不是整份丢弃。** 一条坏记录不该带走其他好记录。
 * - **顺手排序与去重。** 文件是手改得动的，读的时候把顺序和重复一次性收敛掉，
 *   后面所有消费者都不必再各自防一遍。
 */
export function parseProjectStore(raw: unknown): ProjectStore {
  if (!raw || typeof raw !== 'object') return emptyProjectStore()

  const source = raw as { version?: unknown; lastOpened?: unknown; projects?: unknown }

  // 版本不认识就整体回落：宁可让用户重新选一次文件夹，也不要按猜测的语义解释数据。
  if (source.version !== PROJECT_STORE_VERSION) return emptyProjectStore()

  const list = Array.isArray(source.projects) ? source.projects : []

  const seen = new Set<string>()
  const projects: ProjectRecord[] = []
  for (const item of list) {
    const record = validRecord(item)
    if (!record) continue

    /**
     * 去重按**大小写敏感**做：这一层不知道平台语义，而合并两个在 Linux 上真实
     * 存在的不同目录，比留下一条重复记录糟得多。主进程在写入前会按平台语义
     * 再收敛一次（见 upsertProject）。
     */
    const key = projectPathKey(record.path, false)
    if (seen.has(key)) continue

    seen.add(key)
    projects.push(record)
  }

  projects.sort((a, b) => b.openedAt - a.openedAt)

  const trimmed = projects.slice(0, MAX_PROJECTS)
  const lastOpened =
    typeof source.lastOpened === 'string' ? normalizeProjectPath(source.lastOpened) : ''

  return {
    version: PROJECT_STORE_VERSION,
    // lastOpened 只认「列表里真的有它」的值，否则启动时会指着一条不存在的记录
    lastOpened: trimmed.some((p) => p.path === lastOpened)
      ? lastOpened
      : (trimmed[0]?.path ?? null),
    projects: trimmed
  }
}

/**
 * 记录一次打开：已有同一条就更新它的时间并挪到最前，否则插入一条。
 *
 * `caseInsensitive` 由调用方按平台语义给（Windows 的路径不区分大小写）。
 */
export function upsertProject(
  store: ProjectStore,
  dirPath: string,
  options: { now: number; caseInsensitive: boolean }
): ProjectStore {
  const normalized = normalizeProjectPath(dirPath)
  if (normalized.length === 0) return store

  const key = projectPathKey(normalized, options.caseInsensitive)
  const rest = store.projects.filter((p) => projectPathKey(p.path, options.caseInsensitive) !== key)

  return {
    version: PROJECT_STORE_VERSION,
    lastOpened: normalized,
    projects: [{ path: normalized, openedAt: options.now }, ...rest].slice(0, MAX_PROJECTS)
  }
}

/** 从列表里移除一条记录。移除的是**记录**，磁盘上的目录不动 */
export function removeProject(
  store: ProjectStore,
  dirPath: string,
  options: { caseInsensitive: boolean }
): ProjectStore {
  const key = projectPathKey(dirPath, options.caseInsensitive)
  const projects = store.projects.filter(
    (p) => projectPathKey(p.path, options.caseInsensitive) !== key
  )

  if (projects.length === store.projects.length) return store

  return {
    version: PROJECT_STORE_VERSION,
    lastOpened:
      store.lastOpened && projectPathKey(store.lastOpened, options.caseInsensitive) === key
        ? (projects[0]?.path ?? null)
        : store.lastOpened,
    projects
  }
}

/** 打开项目的结果。失败带着原因，界面据此给不同的说法 */
export type ProjectFailureReason =
  /** 用户在对话框里取消了 —— 这不是错误，界面不该弹任何东西 */
  | 'cancelled'
  /** 目录不存在 */
  | 'missing'
  /** 路径存在，但不是目录 */
  | 'not-a-directory'

export type ProjectOpenResult =
  { ok: true; project: ProjectRecord } | { ok: false; reason: ProjectFailureReason; path?: string }

/** 目录对话框的两种用途：新建项目 / 打开已有目录 */
export type ProjectPickMode = 'new' | 'open'

/**
 * IPC 通道名。
 *
 * 和 WINDOW_CHANNELS 同理集中在这里：拼错通道名没有编译错误，只会在运行时静默失效。
 */
export const PROJECT_CHANNELS = {
  /** 取「打开过的项目」列表（invoke） */
  list: 'host:project-list',
  /** 按路径打开一个已有记录（invoke） */
  open: 'host:project-open',
  /** 弹系统目录对话框并打开所选目录（invoke），参数是 ProjectPickMode */
  pick: 'host:project-pick',
  /** 从列表里移除一条记录（invoke），返回移除后的列表 */
  remove: 'host:project-remove',
  /**
   * 关闭当前项目并回退到欢迎窗口（invoke）。
   *
   * **不删记录**：这一次会话不再用这个项目，但它仍然是「打开过的项目」，也仍然是
   * 下次启动时要打开的那一个。
   */
  close: 'host:project-close'
} as const
