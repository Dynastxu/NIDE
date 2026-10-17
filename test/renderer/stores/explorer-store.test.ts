import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { ChapterFile, ChapterListResult, DirReadResult, ProjectConfig } from '@shared/project'

/**
 * 文件树 / 项目面板的**启动顺序**测试。
 *
 * 这一份盯的是一件在界面上不容易一眼看清的事：树的根目录、内容目录配置、章节列表
 * 三者有先后（内容目录是相对项目根算出来的），而它们由**不同的面板**发起 —— 而同一
 * 时刻只有一个面板挂载。左上工具区打开时停在「项目」，文件树从来没挂载过。
 *
 * 曾经定根目录这一步由文件树独占（挂在它自己的挂载副作用里），于是「项目」那一面读
 * 配置时根还是空的：列表一直空着，切到「文件」再切回来才好（切回来时根已经有了）。
 * 用例把「谁先挂载都读得出来」这条钉住。
 *
 * 环境是 node：store 在模块求值时就会取一次启动参数里的日志级别，所以 window 必须在
 * import 之前 stub 好（见 loadStore）。
 */

/** 项目根。用 Windows 写法，顺带覆盖「分隔符按根的写法拼」这条 */
const ROOT = 'D:\\Novel'
const CHAPTERS_DIR = `${ROOT}\\chapters`

const CONFIG: ProjectConfig = {
  chapters: { path: 'chapters' },
  gallery: { path: 'gallery', characters: 'characters' },
  foreshadowing: { path: 'foreshadowing' },
  overview: { path: 'overview' }
}

const CHAPTER: ChapterFile = {
  path: `${CHAPTERS_DIR}\\chapter_1.md`,
  name: 'chapter_1.md',
  chapter: 1,
  heading: '决战前夜'
}

/** 主进程那三个读通道的替身 */
interface Host {
  readDir: Mock<(dirPath: string) => Promise<DirReadResult>>
  readConfig: Mock<() => Promise<ProjectConfig>>
  readChapters: Mock<(dirPath: string) => Promise<ChapterListResult>>
}

/**
 * 摆一个渲染进程的 window。没有项目时（欢迎窗口）`projectPath` 传 null。
 *
 * 只提供 store 真正会碰到的那几项：读目录、读配置、读章节列表，以及日志出口
 * （它缺失时日志会被丢弃，但那只会在用例失败时发生）。
 */
function installWindow(projectPath: string | null): Host {
  const readDir = vi.fn(async (dirPath: string): Promise<DirReadResult> => ({
    ok: true,
    path: dirPath,
    entries: []
  }))
  const readConfig = vi.fn(async (): Promise<ProjectConfig> => CONFIG)
  const readChapters = vi.fn(async (dirPath: string): Promise<ChapterListResult> => ({
    ok: true,
    path: dirPath,
    chapters: [CHAPTER]
  }))

  vi.stubGlobal('window', {
    __NIDE_BOOT__: { projectPath, logLevel: 'error' },
    hostAPI: {
      log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      projects: { readDir, readConfig, readChapters }
    }
  })

  return { readDir, readConfig, readChapters }
}

/**
 * 取一份**全新**的 store。
 *
 * 每个用例都要一份新的：根目录与配置都是「一次会话里只定一次」的东西，共用一个实例
 * 会让第二个用例看到第一个用例留下的状态。resetModules 顺带把模块求值时的 window
 * 读取也重来一遍。
 */
async function loadStore(): Promise<
  (typeof import('@renderer/stores/explorer.store'))['useExplorerStore']
> {
  vi.resetModules()
  const module = await import('@renderer/stores/explorer.store')
  return module.useExplorerStore
}

describe('文件树与项目面板的启动顺序', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('「项目」先挂载时，配置与内容目录照样读得出来', async () => {
    const host = installWindow(ROOT)
    const store = await loadStore()

    // 启动时停在「项目」：文件树没有挂载过，谁都没定过根目录
    expect(store.getState().roots).toEqual([])

    // 这一句就是 ProjectsPanel 挂载时做的事
    await store.getState().loadConfig()

    expect(store.getState().roots).toEqual([ROOT])
    expect(store.getState().config).toEqual(CONFIG)
    expect(store.getState().chaptersDir).toBe(CHAPTERS_DIR)
    expect(host.readConfig).toHaveBeenCalledTimes(1)
    expect(host.readDir).toHaveBeenCalledWith(ROOT)
  })

  it('章节列表读的是配置算出来的目录', async () => {
    const host = installWindow(ROOT)
    const store = await loadStore()

    await store.getState().loadChapters()

    expect(host.readChapters).toHaveBeenCalledWith(CHAPTERS_DIR)
    expect(store.getState().chapters).toEqual([CHAPTER])
  })

  it('根目录已经定过时不重读：切一次标签页不该把树清空重来', async () => {
    const host = installWindow(ROOT)
    const store = await loadStore()

    await store.getState().ensureRoots()
    await store.getState().ensureRoots()

    expect(store.getState().roots).toEqual([ROOT])
    expect(host.readDir).toHaveBeenCalledTimes(1)
  })

  it('没有项目时读配置直接返回，不发 IPC', async () => {
    const host = installWindow(null)
    const store = await loadStore()

    await store.getState().loadConfig()

    expect(store.getState().roots).toEqual([])
    expect(store.getState().config).toBeNull()
    expect(host.readConfig).not.toHaveBeenCalled()
  })
})
