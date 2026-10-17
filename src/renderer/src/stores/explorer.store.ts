import { create } from 'zustand'
import { getT } from './i18n.store'
import {
  isInsideProject,
  languageForPath,
  type ChapterFile,
  type ChapterListResult,
  type CreateEntryKind,
  type CreateEntryResult,
  type DeleteEntryResult,
  type DirReadFailureReason,
  type FileTreeEntry,
  type ProjectConfig,
  type RenameEntryResult
} from '@shared/project'
import { loggerFor } from '@renderer/logger'
import { useEditorStore } from './editor.store'
import { useGalleryStore } from './gallery.store'

const logger = loggerFor('explorer')

/**
 * 项目文件树的状态。
 *
 * 只放**目录树**：打开了哪些文件、当前看的是哪一个属于 editor store
 * （见 stores/editor.store.ts）。两者分开是因为它们的生命周期不一样 ——
 * 关掉一个标签页不该影响树，收起一个目录也不该影响编辑器。
 *
 * ## 多个根
 *
 * `roots` 是数组，不是单个路径。目前只装项目目录一个，但**临时文件夹**将来要作为
 * 第二个根挂到同一棵树里（「被选择的文件夹作为根」这条需求正是为此铺的路）。
 * 数组形态与下面的 `pinned` 机制一起，让「只看某一支」不需要任何新的渲染分支。
 *
 * ## pinned：把某一支当根看（**当前没有界面入口**）
 *
 * `pinned` 里放着若干目录。它为空时整棵树按 roots 全量展示；非空时**只有这些目录
 * 及其子孙**可见（见 shared/project 的 createChildVisibility）。
 *
 * 界面上的入口（右键「只显示这个文件夹」）**已经被去掉**：一个「把文件夹当根」的
 * 半成品留着比没有更糟。这套机制保留下来是因为**临时文件夹**要作为第二个根挂进同一棵树
 * （见上面的 roots），那时「限制在哪些根里」是必需的一步；共享层的判定函数与用例仍在，
 * 接回来时不会从零开始。
 *
 * 过滤是**判出来的**（一个「这个目录的子项该不该显示」的谓词），没有第二份树结构：
 * 节点的父子关系始终来自主进程给的绝对路径，不会因为过滤而与磁盘上的样子分叉。
 *
 * ## 逐层读
 *
 * 目录内容在展开时才经 IPC 取回并缓存进 `children`。整棵树一次读完在小说项目上
 * 也许可行，但目录一大就是一次长卡顿。
 */

interface ExplorerState {
  /** 树的根目录（项目；将来可能加上临时文件夹）。空数组表示没有树可显示 */
  roots: string[]
  /** 目录绝对路径 -> 该目录的子项。没有条目表示还没读过 */
  children: Record<string, FileTreeEntry[]>
  /** 已经展开的目录 */
  expanded: Record<string, boolean>
  /** 被当作「根」来看的目录。空表示展示整棵树。当前没有界面入口，见文件头 */
  pinned: Record<string, true>
  /** 正在读的目录。用来在树上显示占位，也用来挡住重复请求 */
  loading: Record<string, boolean>
  /** 每个目录各自的读取失败原因 */
  errors: Record<string, DirReadFailureReason>
  /**
   * 最近一次文件操作失败的提示，null 表示没有。
   *
   * **画在窗口底部的全局浮层里**（见 entry/EntryActionHost），不是树顶上的一条：
   * 发起这些动作的入口不止文件树一个（章节列表里也有一份条目菜单），提示留在某一个
   * 面板里就会出现「用户没在看那个面板」。下一次成功的操作会把它清掉。
   */
  notice: string | null

  /**
   * 当前项目的配置（`.nide/config.yml`：四个内容分区，图鉴那一段还带着角色图鉴）。
   *
   * null 表示**还没读过**，不是「没有配置」：主进程的读通道会在配置缺失或坏掉时
   * 静默重建一份默认配置，所以读到了就一定有一份可用的。放在这里是因为它属于
   * 「当前项目有哪些内容目录」—— 与文件树同一件事实，生命周期也一样（换项目就重建）。
   */
  config: ProjectConfig | null
  /** 正在读配置 */
  configLoading: boolean
  /** 章节目录的绝对路径；null 表示还没有配置（读不到目录） */
  chaptersDir: string | null
  /** 章节目录里的章节列表；null 表示**还没读过**（空数组表示确实没有章节） */
  chapters: ChapterFile[] | null
  /** 读章节列表的失败原因 */
  chaptersError: DirReadFailureReason | null
  /** 正在读章节列表 */
  chaptersLoading: boolean

  /**
   * 补一次根目录：启动参数里有项目、而根还没定在它上面时才真正去读。
   *
   * **幂等**。任何要用到树、或要用到「内容目录的绝对路径」的一方，在动手之前都该先
   * 调它一次 —— 它把「项目在哪儿」这件事收在 store 里，调用方不必各自去读启动参数。
   * 反复调它不会清掉缓存，所以它可以挂在随时会重新挂载的地方（见 ExplorerView 的
   * 文件树那一面）。
   */
  ensureRoots: () => Promise<void>
  /**
   * 直接定下根目录并读它的第一层，**不判重**。
   *
   * 这是「换了一个项目」用的重置：缓存、展开状态、配置与章节列表一起丢掉之后重来。
   * 日常补根走 ensureRoots，否则每次挂载都会把树清空重读。
   */
  setRoots: (roots: string[]) => Promise<void>
  /**
   * 读一次项目配置并据此定下四个内容目录的绝对路径。
   *
   * 已经读过时直接返回：配置在一次会话里不会变（改配置要重建窗口），重复读只是浪费
   * 一次 IPC。要重新读就把它当「换项目」处理（setRoots 会清空这一份）。
   */
  loadConfig: () => Promise<void>
  /** 读一次章节列表。目录未知时先读配置。失败记进 chaptersError，不抛 */
  loadChapters: () => Promise<void>
  /**
   * 读一次图鉴列表（内容目录下每个子目录一个图鉴）。
   *
   * 与 loadChapters 同一条理由与同一个位置：图鉴也是「当前项目有哪些内容」，目录要从
   * 配置里算出来，而图鉴的消费者不止这一个面板（章节表单要选角色、图鉴表单要字段表）。
   * 真正的读盘与缓存归 gallery store，这里只负责把「项目根 + 配置」翻译成绝对路径 ——
   * 那是这一层才知道的事（见 gallery.store 文件头）。
   *
   * `force` 是刷新：图鉴的增删改都发生在界面上，那些动作之后要重读一次。
   */
  loadGalleries: (force?: boolean) => Promise<void>
  /** 重新读一个目录（新建条目之后用它把新节点显示出来） */
  refreshDir: (dirPath: string) => Promise<void>
  /** 展开 / 收起一个目录。首次展开时才去读它 */
  toggle: (dirPath: string) => Promise<void>
  /**
   * 丢掉一个路径的缓存：目录内容、展开状态、错误与加载标记一起清。
   *
   * 用在**重命名**之后：旧路径在新的一轮里已经不存在了，留着它的 `children`
   * 会让它下面的子项继续挂在树上（那些 key 永远不会再被问到，但也不会消失）。
   */
  forgetPath: (targetPath: string) => void
  /**
   * 丢掉**一整棵子树**的缓存（含 target 自己）。
   *
   * 与 forgetPath 分开是因为删除要处理的是「已经展开过的子孙」：删掉 `卷一` 之后，
   * `卷一/第一节` 这些路径在磁盘上都不存在了，而它们的 `children` 还躺在缓存里。
   * 判据用与主进程同一套逐段比对（`isInsideProject`），前缀相同的兄弟目录不会被误伤。
   */
  forgetSubtree: (targetPath: string) => void
  /** 展开到某个条目（打开文件后把它的父目录链展开） */
  reveal: (targetPath: string) => Promise<void>
  /** 底部那条提示。写进它的文案由调用方翻好（见 notice 的说明） */
  setNotice: (notice: string | null) => void
}

/**
 * 打开文件失败的原因 -> 词条 key（见 preload 的 FileReadFailureReason）。
 *
 * 目录读取失败的原因不在这里：它随树节点一起渲染，由 ExplorerView 直接查表，
 * 不必先翻成一句话再存进 store —— 那样语言切换后树里会留着旧语言的文案。
 */
const OPEN_FAILURE_KEYS = {
  'invalid-path': 'host.explorer.open.failed.invalid-path',
  'outside-project': 'host.explorer.open.failed.outside-project',
  'not-a-file': 'host.explorer.open.failed.not-a-file',
  unreadable: 'host.explorer.open.failed.unreadable'
} as const

/** 一次目录读取。in-flight 表按路径去重，重复点开同一个目录不会发两次 IPC */
const inflight = new Map<string, Promise<void>>()

/** 路径最后一段之前的部分；没有分隔符时返回空串 */
function parentOf(target: string): string {
  const index = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  return index <= 0 ? '' : target.slice(0, index)
}

/**
 * 从某个根到 target 的**每一层目录**（含根，不含 target 自己）。
 *
 * 逐段拼接而不是自己数分隔符：Windows 上 `\` 与 `/` 混用是常态，而最终要拿这些
 * 路径去查 children 的 key —— key 是主进程给的，必须还原成主进程用的那一种写法。
 * 所以以 root 的写法为准。
 *
 * 「哪个根装着 target」用 shared 的 isInsideProject 判断：逐段比对、大小写一律
 * 折叠，前缀相同的兄弟目录不会被误判成「在它之内」。
 */
function ancestorChain(roots: string[], target: string): string[] {
  const root = roots.find((candidate) => isInsideProject(candidate, target, true))
  if (!root) return []

  const separator = root.includes('\\') ? '\\' : '/'
  const depth = segments(root).length
  const targetParts = segments(target)
  const chain: string[] = []

  // 从根自己开始，一直拼到 target 的父目录
  for (let end = depth; end < targetParts.length; end++) {
    chain.push(targetParts.slice(0, end).join(separator))
  }

  return chain
}

/** 按任意分隔符切段，丢掉空段 */
function segments(value: string): string[] {
  return value.split(/[\\/]/).filter((segment) => segment.length > 0)
}

/**
 * 把「项目根」与「配置里的相对目录」拼成绝对路径。
 *
 * 分隔符按**根**的写法给（根里出现过 `\` 就用 `\`）：主进程的 `path.join` 用的是
 * 平台分隔符，而 `children` / `chapters` 这些缓存都以主进程给的路径为 key ——
 * 这里拼出另一种写法就会查不到自己。
 *
 * 配置里的路径已经过 normalizeConfigDirectory（`/` 分段、无 `..`），所以这里只需要
 * 逐段接上去。
 *
 * 导出是给 gallery store 用的（它收一个图鉴目录的绝对路径，见那里的文件头）：这条
 * 拼法只该有一处，两个 store 各拼一次迟早会拼出两种写法。
 */
export function joinProjectPath(root: string, relative: string): string {
  const separator = root.includes('\\') ? '\\' : '/'
  const head = root.replace(/[\\/]+$/, '')

  const tail = segments(relative)
  return tail.length === 0 ? head : `${head}${separator}${tail.join(separator)}`
}

/** 摘掉一个 key，返回新对象（zustand 需要新引用才会触发重渲染） */
function withoutKey<T>(source: Record<string, T>, key: string): Record<string, T> {
  if (!(key in source)) return source
  const next = { ...source }
  delete next[key]
  return next
}

export const useExplorerStore = create<ExplorerState>((set, get) => {
  /**
   * 读一层目录并写进缓存。
   *
   * `force` 是「刷新」要的语义：**丢掉缓存、绕过去重**再读一次。不 force 时命中
   * 缓存或已有同路径的请求就直接复用 —— 反复点开同一个目录不该发第二次 IPC。
   */
  async function readDir(dirPath: string, force = false): Promise<void> {
    if (force) inflight.delete(dirPath)

    const existing = force ? undefined : inflight.get(dirPath)
    if (existing) return existing

    set((s) => ({
      loading: { ...s.loading, [dirPath]: true },
      errors: withoutKey(s.errors, dirPath)
    }))

    const task = window.hostAPI.projects
      .readDir(dirPath)
      .then((result) => {
        if (result.ok) {
          set((s) => ({ children: { ...s.children, [dirPath]: result.entries } }))
          return
        }

        logger.warn('Failed to read a directory for the tree', {
          dir: dirPath,
          reason: result.reason
        })
        set((s) => ({
          children: { ...s.children, [dirPath]: [] },
          errors: { ...s.errors, [dirPath]: result.reason }
        }))
      })
      .catch((err: unknown) => {
        // 主进程的 handle 不该抛，但真抛了也不能让树停在「加载中」
        logger.error('Directory read failed unexpectedly', { error: err })
        set((s) => ({
          children: { ...s.children, [dirPath]: [] },
          errors: { ...s.errors, [dirPath]: 'unreadable' }
        }))
      })
      .finally(() => {
        inflight.delete(dirPath)
        set((s) => ({ loading: withoutKey(s.loading, dirPath) }))
      })

    inflight.set(dirPath, task)
    return task
  }

  /** 展开一条目录链（从根到 target 的每一层），已经读过的层直接用缓存 */
  async function expandTo(target: string): Promise<void> {
    const { roots } = get()
    if (roots.length === 0) return

    for (const dirPath of ancestorChain(roots, target)) {
      // 先标记展开：目录链再长也不会出现「展开到一半」的中间态
      set((s) => ({ expanded: { ...s.expanded, [dirPath]: true } }))
      if (!get().children[dirPath]) await readDir(dirPath)
    }
  }

  return {
    roots: [],
    children: {},
    expanded: {},
    pinned: {},
    loading: {},
    errors: {},
    notice: null,
    config: null,
    configLoading: false,
    chaptersDir: null,
    chapters: null,
    chaptersError: null,
    chaptersLoading: false,

    ensureRoots: async () => {
      const projectPath = window.__NIDE_BOOT__.projectPath
      if (!projectPath) return

      /*
       * 根已经定在这个项目上就什么都不做。重来一次会把 children 与 expanded 一起清掉
       * —— 那是「切走再切回来，树就收起了、目录要重新展开」的来源，读盘本身也是一次
       * 白费的往返。要重置走 setRoots（它不判重）。
       *
       * 判据是「项目根已经在 roots 里」，不是「roots 恰好只有一项」：临时文件夹将来是
       * 第二个根（见文件头），那时这个判断照样成立。
       */
      if (get().roots.includes(projectPath)) return

      await get().setRoots([projectPath])
    },

    setRoots: async (roots) => {
      inflight.clear()
      /*
       * 图鉴那一份也一起丢掉：换项目就是换一套内容目录，而图鉴列表与注册表都是**一次
       * 性读盘的结论**（见 gallery.store 的生命周期说明）。不丢的话，新项目会先带着
       * 上一个项目的图鉴渲染一帧。
       */
      useGalleryStore.getState().forget()

      set({
        roots,
        children: {},
        expanded: Object.fromEntries(roots.map((root) => [root, true])),
        pinned: {},
        loading: {},
        errors: {},
        notice: null,
        // 换项目就是换一套内容目录与章节列表：这一份必须跟着清掉，
        // 否则新的项目会先带着上一个项目的章节列表渲染一帧
        config: null,
        configLoading: false,
        chaptersDir: null,
        chapters: null,
        chaptersError: null,
        chaptersLoading: false
      })

      for (const root of roots) await readDir(root)
    },

    loadConfig: async () => {
      // 已经读过就不重读：配置在一次会话里不会变（改配置要重建窗口）
      if (get().config || get().configLoading) return

      set({ configLoading: true })
      try {
        /*
         * 内容目录是相对**项目根**算出来的，所以根必须先定下来。这一步不能假设文件树
         * 已经做过它：「项目」是默认标签页，启动时文件树根本没挂载过，而挂载副作用是
         * **子组件先于父组件**跑的 —— 谁先谁后由不得调用方。补根因此放在这里，而不是
         * 放在某一个面板的挂载处（否则「项目」那一面读配置时根还是空的，列表一直空着，
         * 切到「文件」再切回来才好）。
         */
        await get().ensureRoots()

        const root = get().roots[0]
        if (!root) return

        const config = await window.hostAPI.projects.readConfig()
        if (!config) {
          logger.warn(
            'The project configuration is unavailable, the content directories stay unknown'
          )
          return
        }

        set({
          config,
          // 内容目录是相对项目根的，绝对路径在这里一次算出来 —— 下游（章节列表、
          // 将来的图鉴与伏笔）拿到的都该是能直接用的绝对路径
          chaptersDir: joinProjectPath(root, config.chapters.path)
        })
      } catch (err) {
        logger.error('Reading the project configuration failed unexpectedly', { error: err })
      } finally {
        set({ configLoading: false })
      }
    },

    loadChapters: async () => {
      if (get().chaptersLoading) return

      if (!get().chaptersDir) await get().loadConfig()

      const dir = get().chaptersDir
      if (!dir) return

      set({ chaptersLoading: true, chaptersError: null })
      try {
        const result: ChapterListResult = await window.hostAPI.projects.readChapters(dir)
        if (!result.ok) {
          logger.warn('Failed to read the chapter list', { dir, reason: result.reason })
          // chapters 保持原样（可能还是 null）：错误由 chaptersError 表达，
          // 界面据此显示「读不了」而不是「没有章节」
          set({ chaptersError: result.reason })
          return
        }

        set({ chapters: result.chapters })
      } catch (err) {
        logger.error('Reading the chapter list failed unexpectedly', { error: err })
        set({ chaptersError: 'unreadable' })
      } finally {
        set({ chaptersLoading: false })
      }
    },

    loadGalleries: async (force = false) => {
      // 目录要从配置里算出来（与 loadChapters 同一条路：配置自己会先补上项目根）
      if (!get().config) await get().loadConfig()

      const root = get().roots[0]
      const config = get().config
      if (!root || !config) return

      await useGalleryStore.getState().load(joinProjectPath(root, config.gallery.path), force)
    },

    toggle: async (dirPath) => {
      const open = get().expanded[dirPath] ?? false
      set((s) => ({ expanded: { ...s.expanded, [dirPath]: !open } }))

      if (open) return
      if (!get().children[dirPath]) await readDir(dirPath)
    },

    refreshDir: async (dirPath) => {
      // 先把缓存丢掉，再按 force 读 —— 否则 readDir 会直接返回缓存里那份旧内容
      set((s) => ({ children: withoutKey(s.children, dirPath) }))
      await readDir(dirPath, true)
    },

    forgetPath: (targetPath) => {
      inflight.delete(targetPath)

      set((s) => ({
        children: withoutKey(s.children, targetPath),
        expanded: withoutKey(s.expanded, targetPath),
        loading: withoutKey(s.loading, targetPath),
        errors: withoutKey(s.errors, targetPath)
      }))
    },

    forgetSubtree: (targetPath) => {
      /**
       * 被删掉的那些路径。
       *
       * 大小写**不折叠**（第三个参数传 false）：这一层判的是「这些 key 是不是同一个
       * 字符串」，而所有 key 都是主进程用同一套写法生成的 —— 折叠反而会把
       * `卷一` 与 `卷一2` 这种前缀关系之外的路径并进来。
       */
      const gone = new Set<string>([targetPath])
      for (const key of Object.keys(get().children)) {
        if (isInsideProject(targetPath, key, false)) gone.add(key)
      }

      // 正在读的那个目录也要作废，否则它读完之后会把结果写回缓存
      for (const key of gone) inflight.delete(key)

      const withoutGone = <T>(source: Record<string, T>): Record<string, T> => {
        let next = source
        for (const key of gone) next = withoutKey(next, key)
        return next
      }

      set((s) => ({
        children: withoutGone(s.children),
        expanded: withoutGone(s.expanded),
        loading: withoutGone(s.loading),
        errors: withoutGone(s.errors)
      }))
    },

    reveal: async (targetPath) => {
      if (get().roots.length === 0) return
      await expandTo(targetPath)
    },

    setNotice: (notice) => set({ notice })
  }
})

/**
 * 一个条目改动之后，那些**从磁盘读出来的缓存**该不该跟着刷新。
 *
 * 同一份内容在**几处**各有一份缓存：文件树的 `children`、「项目」标签页的 `chapters`
 * （读的是章节目录）、以及图鉴列表（每个图鉴的条目与字段表）。一次新建 / 改名 / 删除
 * 只发生在其中一个入口，不在这里一起刷的话，改完名之后另一处会一直显示旧名字 ——
 * 直到那个面板被重新挂载。以前只有文件树能发起这些动作，这一点不明显；现在条目菜单
 * 在章节列表与图鉴列表里也各有一份（见 renderer/src/entry），不刷就是当场看得见的错。
 *
 * 范围判断用 `isInsideProject`（逐段比对、大小写折叠），与文件树自己算祖先链时同一套：
 * 判断的是「这个路径是不是在那个目录里」，不是「两次拿到的字符串是否一模一样」。
 */
async function refreshContentCaches(paths: string[]): Promise<void> {
  const store = useExplorerStore.getState()
  const touches = (dir: string | null): boolean =>
    dir !== null && paths.some((path) => isInsideProject(dir, path, true))

  // 配置还没读出来时没有章节列表、也没有图鉴目录可刷，也就不必它去读一次配置
  if (touches(store.chaptersDir)) await store.loadChapters()

  const galleryRoot = useGalleryStore.getState().root
  if (galleryRoot !== null && touches(galleryRoot)) await store.loadGalleries(true)
}

/**
 * 打开一个文件：读盘成功后把它作为一个标签页打开。
 *
 * 放在这里而不是编辑器组件里：树知道「哪个条目被点了」。
 *
 * **不做**「支不支持」的判断：打不开的格式在树上点选之后只显示一句说明、根本不走
 * 这条路（见 ExplorerView 的 EntryRow）。在这里再判一次会形成两处真相，而其中
 * 一处迟早会忘了改 —— 真正的边界在主进程（isSupportedTextPath）。
 */
export async function openProjectFile(entry: { path: string; name: string }): Promise<void> {
  const store = useExplorerStore.getState()
  store.setNotice(null)

  try {
    const result = await window.hostAPI.projects.readFile(entry.path)

    if (!result.ok) {
      const text = getT()(OPEN_FAILURE_KEYS[result.reason])
      logger.warn('Failed to open a file', { name: entry.name, reason: result.reason })
      store.setNotice(text)
      return
    }

    // 内容已经在手上，标签页不必再去读一次盘（editor store 只收内容）
    useEditorStore.getState().openFile({
      path: result.path,
      name: entry.name,
      language: languageForPath(result.path),
      content: result.content
    })

    await store.reveal(result.path)
  } catch (err) {
    logger.error('Opening a file failed unexpectedly', { error: err })
  }
}

/**
 * 新建一个条目（文件或文件夹）。
 *
 * 返回失败原因，**不自己弹提示**：这个动作由对话框触发，失败时对话框要留在原地
 * 让用户改名字（「这个名字已经有了」是可以就地修好的，把对话框关掉再让他重新
 * 右键一次是白费一次操作）。
 *
 * 成功后：刷新目标目录、展开它，新目录再读一层（刚建好的目录是空的，读出来才会
 * 显示「空目录」那一行）。新文件**不自动打开** —— 用户可能只是先占个位置，
 * 自动打开会把他正在看的那一章顶掉。
 */
export async function createProjectEntry(
  kind: CreateEntryKind,
  targetPath: string,
  name: string
): Promise<CreateEntryResult> {
  const store = useExplorerStore.getState()

  const result = await window.hostAPI.projects.createEntry({ kind, targetPath, name })
  if (!result.ok) {
    logger.warn('Failed to create an entry', { kind, reason: result.reason })
    return result
  }

  const parentDir = parentOf(result.path)
  store.setNotice(null)

  // 目录要展开才会显示新子项（reveal 会把链上的目录都展开并读出来）
  await store.reveal(result.path)
  await store.refreshDir(parentDir)

  if (kind === 'directory') await store.refreshDir(result.path)

  // 建在内容目录里的条目也要在章节列表 / 图鉴列表里出现（见 refreshContentCaches）
  await refreshContentCaches([result.path])

  return result
}

/**
 * 给一个条目改名。
 *
 * 与新建同一套约定：返回失败原因、**不自己弹提示**（对话框要留在原地让用户改名字），
 * 成功后把树刷成新的样子。
 *
 * 三件事按顺序做：
 * 1. 目标目录**重新读一次**（改名不改目录，但同名的那个条目换了名字）；
 * 2. 旧路径的缓存**丢掉**，否则树里会同时留着旧名字和新名字两条；
 * 3. 打开着的标签页跟着换路径 —— 否则它会指向一个不存在的文件。
 *
 * 不做「先本地改缓存、失败再改回来」那种乐观更新：重命名是一次很快的盘上操作，
 * 而猜错的代价是树和磁盘说的不一样。
 */
export async function renameProjectEntry(
  targetPath: string,
  name: string
): Promise<RenameEntryResult> {
  const store = useExplorerStore.getState()

  const result = await window.hostAPI.projects.renameEntry({ targetPath, name })
  if (!result.ok) {
    logger.warn('Failed to rename an entry', { target: targetPath, reason: result.reason })
    return result
  }

  store.setNotice(null)

  // 标签页按路径认文件，改名之后必须跟着走（文件 → 目录：那一支的标签页都跟着）
  useEditorStore.getState().migratePath(result.previousPath, result.path)

  const parentDir = parentOf(result.path)
  await store.refreshDir(parentDir)
  store.forgetPath(result.previousPath)

  // 章节 / 图鉴列表里按旧名字排着的那一条要跟着换（见 refreshContentCaches）
  await refreshContentCaches([result.previousPath, result.path])

  return result
}

/**
 * 删掉一个条目（文件或目录；目录连同里面的东西一起删）。
 *
 * **不可撤销**，所以这一问由主进程在动作出口处问（见 main/confirm.ts）：无论谁
 * 发起删除都会经过那一问，界面不自己弹框。调用方拿到 `cancelled` 时什么都不该做 ——
 * 用户自己按了「取消」，那不是失败（见 ExplorerView 的 requestDelete）。
 *
 * 顺序上有讲究：先把树里那些「已经不存在的路径」的缓存整棵丢掉，**再**读父目录。
 * 反过来的话，父目录读回来时旧路径还在缓存里，树里会短暂地同时留下它和它的子项。
 */
export async function deleteProjectEntry(targetPath: string): Promise<DeleteEntryResult> {
  const store = useExplorerStore.getState()

  const result = await window.hostAPI.projects.deleteEntry({ targetPath })
  if (!result.ok) {
    // 「取消」是用户的决定，不是故障：两个级别分开记，排查时才不会被它带偏
    if (result.reason === 'cancelled') {
      logger.info('Delete cancelled by the user', { target: targetPath })
    } else {
      logger.warn('Failed to delete an entry', { target: targetPath, reason: result.reason })
    }
    return result
  }

  store.setNotice(null)

  // 打开着的标签页要一并关掉：它的文件已经不在了，留着就是一个点不开的空标签
  useEditorStore.getState().closeSubtree(targetPath)

  store.forgetSubtree(targetPath)
  await store.refreshDir(parentOf(targetPath))

  // 章节 / 图鉴列表里那一行也要消失（见 refreshContentCaches）
  await refreshContentCaches([targetPath])

  return result
}
