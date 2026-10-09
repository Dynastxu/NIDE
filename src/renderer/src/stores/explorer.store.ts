import { create } from 'zustand'
import { getT } from './i18n.store'
import {
  isInsideProject,
  languageForPath,
  type CreateEntryKind,
  type CreateEntryResult,
  type DirReadFailureReason,
  type FileTreeEntry
} from '@shared/project'
import { loggerFor } from '@renderer/logger'

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
  /** 打开 / 新建失败的提示（渲染在树的顶部），null 表示没有 */
  notice: string | null

  /** 启动时调一次：定下根目录并读它的第一层 */
  setRoots: (roots: string[]) => Promise<void>
  /** 展开 / 收起一个目录。首次展开时才去读它 */
  toggle: (dirPath: string) => Promise<void>
  /** 重新读一个目录（新建条目之后用它把新节点显示出来） */
  refreshDir: (dirPath: string) => Promise<void>
  /** 展开到某个条目（打开文件后把它的父目录链展开） */
  reveal: (targetPath: string) => Promise<void>
  /** 顶部提示 */
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

    setRoots: async (roots) => {
      inflight.clear()
      set({
        roots,
        children: {},
        expanded: Object.fromEntries(roots.map((root) => [root, true])),
        pinned: {},
        loading: {},
        errors: {},
        notice: null
      })

      for (const root of roots) await readDir(root)
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

    reveal: async (targetPath) => {
      if (get().roots.length === 0) return
      await expandTo(targetPath)
    },

    setNotice: (notice) => set({ notice })
  }
})

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
    const { useEditorStore } = await import('./editor.store')
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

  return result
}
