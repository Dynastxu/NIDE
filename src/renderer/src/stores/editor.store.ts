import { create } from 'zustand'
import { baseNameOf, isInsideProject, languageForPath } from '@shared/project'

/**
 * 主编辑区的状态：**打开了哪些文件、当前看的是哪一个**。
 *
 * 这里有两点是刻意的：
 *
 * 1. **不是「一个当前文件」，而是一组标签页。** 中间区域不再代表某一支文件，
 *    而是代表一整组「这次会话打开过的东西」。识别一个标签页用**路径**，因为
 *    路径来自主进程、天然唯一；文件名只用来显示（同名文件在不同目录里很常见）。
 * 2. **标签页里没有正文。** 正文归 Monaco 的 model（按 URI 建，见
 *    editor/EditorTabs.tsx），这里只留一个 `originalValue` 当作「与磁盘一致」
 *    的基准，用来算 `dirty`。两份正文迟早会不一致，而那时没人知道该信谁。
 */

export interface EditorTab {
  /** 文件绝对路径。标签页的身份 */
  path: string
  /** 显示名（路径最后一段） */
  name: string
  /** Monaco 的语言 id，由 shared/project 的 languageForPath 推导 */
  language: string
  /** 从磁盘读到的原样内容。与当前正文不同即为「有未保存的改动」 */
  originalValue: string
  /**
   * 与磁盘不一致。
   *
   * 宿主目前**没有实现保存**（见 editor/EditorTabs.tsx 的说明），所以这个标记
   * 只能提示「这些改动还没落盘」，界面据此给出说法。
   */
  dirty: boolean
  /**
   * 「这个标签页被重新打开过」的计数。
   *
   * 每次 `openFile` 命中一个已经开着的标签页就 +1。它的唯一用途是给编辑器一个
   * **一次性**的信号：把 model 拉回磁盘上的版本。
   *
   * 为什么不能只看 originalValue：正文本身不在 store 里，而 originalValue 在
   * 「用户正在改这个文件」时是**不变的**（改的是 model，store 只重算 dirty）。
   * 所以「model 与 originalValue 不同」既可能是「刚重新打开」，也可能是「用户
   * 正在打字」—— 后者一旦被当成前者处理，用户敲一个字符就会被回退一次。
   * 一个单调递增的计数没有这个歧义。
   */
  refreshToken: number
}

interface EditorState {
  /** 按打开顺序排列的标签页 */
  tabs: EditorTab[]
  /** 当前活跃的标签页路径；null 表示一个都没开 */
  activePath: string | null
  /** 需要展示的 Diff（AI 提议修改时触发）。与标签页无关，是覆盖在上面的浮层 */
  pendingDiff: { original: string; modified: string } | null

  /**
   * 打开一个文件。
   *
   * 已经打开过的**不重复建标签页**，只是切过去、并把 `originalValue` 刷新成
   * 这次读到的内容 —— 重开一次代表的正是「以磁盘上的版本为准」。刷新会推进
   * `refreshToken`，编辑器据此把 model 也拉回同一份内容（见 EditorTabs）。
   */
  openFile: (file: { path: string; name: string; language: string; content: string }) => void
  /** 切到某个标签页。路径不存在时什么都不做 */
  setActive: (path: string) => void
  /**
   * 关掉一个标签页。
   *
   * 关掉当前这一个时，焦点交给**右邻**（没有右邻就交给左邻）—— 与浏览器标签页
   * 一致：连按几次关闭，看到的是同一批文件按打开顺序退出，而不是焦点来回跳。
   */
  closeTab: (path: string) => void
  /** 正文变化（用户在编辑器里改，或宿主推来新内容）。同步重算 dirty */
  setContent: (path: string, content: string) => void
  /**
   * 磁盘上的内容变了，把新内容记成**这个标签页的新基准**（清掉 dirty）。
   *
   * 与 openFile 的区别只有一处，但那一处很要紧：**不动 activePath**。
   * 宿主（AI 插件）改写一个后台文件不该把用户的视图抢过去 —— 他可能正看着
   * 另一章。返回 false 表示这个文件没开着，调用方据此决定要不要新开标签页。
   */
  syncFromDisk: (path: string, content: string) => boolean

  /**
   * 某个条目在磁盘上换了名字（文件树里的重命名）。
   *
   * 标签页的身份是路径，路径一变这个标签页就再也对不上任何东西了 —— 不跟着走的
   * 后果是它变成一个指向不存在文件的孤儿，关掉它还会顺手释放 model。返回 false
   * 表示那个路径没有开着的标签页，调用方什么都不用做。
   *
   * `name` 与 `language` 一并跟上：`.txt` 改成 `.md` 时高亮要换成 Markdown。
   */
  migratePath: (previousPath: string, nextPath: string) => boolean

  /**
   * 某个条目在磁盘上被删了（文件树里的删除）。
   *
   * 关掉这个文件自己的标签页，以及它作为目录时**里面那个文件**的标签页 —— 那些文件
   * 已经不在磁盘上了，留着就是几个点不开的空标签。焦点按 closeTab 的规则重新落地。
   *
   * `path` 精确相等也算（删的是一个文件）。返回被关掉的条数。
   */
  closeSubtree: (path: string) => number

  showDiff: (original: string, modified: string) => void
  clearDiff: () => void
}

export const useEditorStore = create<EditorState>((set) => ({
  tabs: [],
  activePath: null,
  pendingDiff: null,

  openFile: (file) =>
    set((s) => {
      const existing = s.tabs.find((tab) => tab.path === file.path)

      if (existing) {
        return {
          activePath: file.path,
          tabs: s.tabs.map((tab) =>
            tab.path === file.path
              ? {
                  ...tab,
                  // 语言可能因为文件被改名而变（.txt 改成 .md），顺手跟上
                  name: file.name,
                  language: file.language,
                  originalValue: file.content,
                  dirty: false,
                  refreshToken: tab.refreshToken + 1
                }
              : tab
          )
        }
      }

      return {
        activePath: file.path,
        tabs: [
          ...s.tabs,
          {
            path: file.path,
            name: file.name,
            language: file.language,
            originalValue: file.content,
            dirty: false,
            refreshToken: 0
          }
        ]
      }
    }),

  setActive: (path) =>
    set((s) => (s.tabs.some((tab) => tab.path === path) ? { activePath: path } : {})),

  closeTab: (path) =>
    set((s) => {
      const index = s.tabs.findIndex((tab) => tab.path === path)
      if (index < 0) return {}

      const tabs = s.tabs.filter((tab) => tab.path !== path)

      // 关的不是当前这一个时，焦点不动（用户是在清理开多的标签页）
      if (s.activePath !== path) return { tabs }

      const next = tabs[index] ?? tabs[index - 1] ?? null
      return { tabs, activePath: next?.path ?? null }
    }),

  setContent: (path, content) =>
    set((s) => {
      const index = s.tabs.findIndex((tab) => tab.path === path)
      if (index < 0) return {}

      const tab = s.tabs[index]
      const dirty = content !== tab.originalValue

      /*
       * dirty 没变时返回空对象。
       *
       * 这条不是省事的优化：`onDidChangeModelContent` 在**每一次按键**后都会
       * 触发，如果每次都换一个新数组，标签页条与整棵文件树都会跟着白重渲染一遍。
       * 打字的第一个字符之后 dirty 就一直是 true，所以这里几乎总是走这条早退。
       */
      if (tab.dirty === dirty) return {}

      const tabs = [...s.tabs]
      tabs[index] = { ...tab, dirty }
      return { tabs }
    }),

  syncFromDisk: (path, content) => {
    let found = false

    set((s) => {
      const index = s.tabs.findIndex((tab) => tab.path === path)
      if (index < 0) return {}

      found = true

      const tab = s.tabs[index]
      if (tab.originalValue === content && !tab.dirty) return {}

      const tabs = [...s.tabs]
      tabs[index] = { ...tab, originalValue: content, dirty: false }
      return { tabs }
    })

    return found
  },

  migratePath: (previousPath, nextPath) => {
    let found = false

    set((s) => {
      const index = s.tabs.findIndex((tab) => tab.path === previousPath)
      if (index < 0) return {}

      /*
       * 目标路径已经开着标签页了：合并成一条，而不是留下两条指向同一个文件的
       * 标签页（重命名成一个「已经打开在别处的」名字时会发生）。
       *
       * 留下的是**老的那一条**（离它原来的位置更近），新名字接上。
       */
      const duplicate = s.tabs.findIndex((tab) => tab.path === nextPath)
      if (duplicate >= 0 && duplicate !== index) {
        found = true

        const tabs = s.tabs.filter((_, position) => position !== index)
        const keptIndex = duplicate > index ? duplicate - 1 : duplicate
        tabs[keptIndex] = {
          ...tabs[keptIndex],
          name: baseNameOf(nextPath),
          language: languageForPath(nextPath)
        }

        return {
          tabs,
          activePath: s.activePath === previousPath ? nextPath : s.activePath
        }
      }

      found = true

      const tabs = [...s.tabs]
      tabs[index] = {
        ...tabs[index],
        path: nextPath,
        name: baseNameOf(nextPath),
        language: languageForPath(nextPath)
      }

      return {
        tabs,
        // 改名的可能正是当前看着的那一个：路径一变，活跃标签页也要跟着换
        activePath: s.activePath === previousPath ? nextPath : s.activePath
      }
    })

    return found
  },

  closeSubtree: (path) => {
    let closed = 0

    set((s) => {
      /*
       * 判据就是「路径相等，或落在它之内」。大小写**不折叠**（第三个参数传 false）：
       * 标签页的路径全部来自主进程、写法一致，而折叠会把 `卷一` 与 `卷一2` 之外
       * 那些本来不该动的东西也拖进来。
       */
      const gone = new Set(
        s.tabs.map((tab) => tab.path).filter((candidate) => isInsideProject(path, candidate, false))
      )
      if (gone.size === 0) return {}

      closed = gone.size
      const tabs = s.tabs.filter((tab) => !gone.has(tab.path))

      // 焦点按 closeTab 的规则重新落地：删掉的若是当前这一个，交给它的右邻（没有就左邻）
      if (s.activePath && gone.has(s.activePath)) {
        // 位置在**原来那个数组**里算，再去掉之后的那一份里取邻居（与 closeTab 同一套算法）
        const index = s.tabs.findIndex((tab) => tab.path === s.activePath)
        const next = tabs[index] ?? tabs[index - 1] ?? null
        return { tabs, activePath: next?.path ?? null }
      }

      return { tabs }
    })

    return closed
  },

  showDiff: (original, modified) => set({ pendingDiff: { original, modified } }),
  clearDiff: () => set({ pendingDiff: null })
}))
