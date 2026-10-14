import { create } from 'zustand'
import {
  baseNameOf,
  isInsideProject,
  languageForPath,
  readChapterMetadata,
  type ChapterMetadata
} from '@shared/project'

/**
 * 主编辑区的状态：**打开了哪些文件、当前看的是哪一个**。
 *
 * 这里有两点是刻意的：
 *
 * 1. **不是「一个当前文件」，而是一组标签页。** 中间区域不再代表某一支文件，
 *    而是代表一整组「这次会话打开过的东西」。识别一个标签页用**路径**，因为
 *    路径来自主进程、天然唯一；文件名只用来显示（同名文件在不同目录里很常见）。
 * 2. **标签页里没有正文。** 正文归 Monaco 的 model（按 URI 建，见
 *    editor/model-registry.ts），这里只留一个 `originalValue` 当作「与磁盘一致」
 *    的基准，用来算 `dirty`。两份正文迟早会不一致，而那时没人知道该信谁。
 */

export interface EditorTab {
  /** 文件绝对路径。标签页的身份 */
  path: string
  /** 显示名（路径最后一段） */
  name: string
  /** Monaco 的语言 id，由 shared/project 的 languageForPath 推导 */
  language: string
  /**
   * 从磁盘读到的原样内容。与当前正文不同即为「有未保存的改动」。
   *
   * 保存成功之后会被推到刚写下去的那一份（见 editor/editor-save.ts）：它是
   * 「与磁盘一致」的基准，而不是「读进来时的那一份」。
   */
  originalValue: string
  /**
   * 标签页**当前**的正文。
   *
   * 与 Monaco 的 model 是同一份文字，这里存一个副本是为了让标签页之外的消费者也能
   * 拿到正文：章节表单与 Markdown 预览都要按正文渲染，而它们不该为此把一个编辑器
   * 实例传下去（正文的所有权在 model-registry，见那里的说明）。
   *
   * 它不是第二个真相：正文只有一处来源（model），`content` 是它每次变化时**推过来**
   * 的结果 —— 用户在编辑器里打字（editor/EditorPanes 的 MonacoHost）与表单改元数据
   * （editor/chapter-metadata.ts）都走同一条 `setDocument`。
   */
  content: string
  /**
   * `content` 里那份 frontmatter 的解析结果（见 editor/chapter-metadata.ts）。
   *
   * 与 `content` 一起更新，所以界面拿到它就知道「这一篇是不是章节、编号是多少」。
   * 没有它的话，每个要问这两个问题的组件都得自己解析一遍 —— 而它们解析的时机
   * 各不相同，迟早会有一个算的是上一版的正文。
   */
  metadata: ChapterMetadata
  /**
   * 与磁盘不一致。
   *
   * 这一个布尔值同时管两件事：标签页上的圆点（「这些改动还没落盘」），以及关掉它时
   * 要不要先问一句「保存吗」（见 requestClose）。
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
   * 排队等着关掉的标签页（路径）。
   *
   * 关标签是**两步**的：没有未落盘改动的直接关，有改动的要先问一句「保存吗」。
   * 一次关多个（关闭其他 / 关闭全部）时，那些要问的必须一个一个问 —— 一次摆出三个
   * 浮层，用户根本分不清哪一句对应哪个文件。所以关闭动作统一进这条队列：队首那个
   * 正在处理，没有改动的会被连续摘掉（见 drainCloseQueue），停在第一个要问的上面。
   *
   * 队首那个就是界面要画「保存吗」的那个（非空即有待决的那一问）。
   */
  closeQueue: string[]

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
   * 请求关掉一个标签页（标签上那个关闭按钮）。
   *
   * 没有未落盘改动就直接关；有改动时**不关**，只把它挂进 `closeQueue` 等用户回答
   * 「保存 / 不保存」。这一问归 editor/UnsavedCloseDialog，保存与关闭的收尾归
   * editor/editor-save.ts —— 这里只决定「要不要问」。
   */
  requestClose: (path: string) => void
  /** 请求关掉除当前这一个以外的全部标签页。没有当前标签页时什么都不做 */
  requestCloseOthers: () => void
  /** 请求关掉所有**没有未落盘改动**的标签页。改过的留着，它们还需要一个去处 */
  requestCloseSaved: () => void
  /** 请求关掉全部标签页 */
  requestCloseAll: () => void
  /**
   * 用户对队首那一问做了决定（保存完了，或者选了「不保存」）：关掉它，继续处理队列。
   *
   * 「保存」先由 editor-save 写盘、把基准推到新内容，再走到这里；「不保存」直接走到
   * 这里 —— 两条路在这一步之后是同一个动作：这个标签页不该再留着了。
   */
  finishClose: () => void
  /** 用户撤销了这次关闭：整条队列一起丢掉（关闭其他 / 关闭全部都就此停下） */
  cancelClose: () => void
  /**
   * 正文变化（用户在编辑器里改，或宿主推来新内容）。
   *
   * 三个字段一起更新：正文本身、由它比出来的 `dirty`、以及重算后的章节元数据（见
   * editor/chapter-metadata.ts）。三者必须同一步落地 —— 分开更新会出现「正文已经
   * 改了、表单还显示着上一版的编号」这种中间态。
   *
   * 正文没有变化时返回空对象：`onDidChangeModelContent` 在**每一次按键**后都会触发，
   * 而每一步都换新引用会让标签条与文件树跟着白重渲染（下面那条早退的说明）。
   */
  setDocument: (path: string, content: string) => void
  /**
   * 磁盘上的内容变了，把新内容记成**这个标签页的新基准**（清掉 dirty）。
   *
   * 与 openFile 的区别只有一处，但那一处很要紧：**不动 activePath**。
   * 宿主（AI 插件）改写一个后台文件不该把用户的视图抢过去 —— 他可能正看着
   * 另一章。返回 false 表示这个文件没开着，调用方据此决定要不要新开标签页。
   *
   * 保存成功之后也走它：那时「磁盘上是什么」与「刚写下去的是什么」是同一份内容。
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
   * 已经不在磁盘上了，留着就是几个点不开的空标签。焦点按 closedTab 的规则重新落地。
   *
   * `path` 精确相等也算（删的是一个文件）。返回被关掉的条数。
   */
  closeSubtree: (path: string) => number

  showDiff: (original: string, modified: string) => void
  clearDiff: () => void
}

/**
 * 「正文 -> 标签页上与它有关的三个字段」。
 *
 * 抽出来是因为正文有**三个**消费者（编辑器、章节表单、Markdown 预览），而它们必须
 * 落在同一份事实上：正文一变，元数据与 dirty 都要跟着重算。让每一处各写一遍，迟早
 * 会出现「正文改了、表单还显示着上一版的编号」。
 *
 * `originalValue` 单独传：它是**磁盘上**的那一份，只在打开与保存时变，不是每次正文
 * 变化都跟着走。
 */
function tabText(
  content: string,
  originalValue: string
): Pick<EditorTab, 'content' | 'metadata' | 'dirty'> {
  return {
    content,
    metadata: readChapterMetadata(content),
    dirty: content !== originalValue
  }
}

/**
 * 与「关标签页」有关的那一半状态。
 *
 * 抽出来是因为关闭有一串公共步骤（算邻居、摘队列），它们既要在 zustand 的更新函数里
 * 用，也要在几条动作之间复用 —— 直接对着整份 EditorState 写会把「标签数组」与
 * 「关闭队列」两件事混在一处。
 */
interface CloseSlice {
  tabs: EditorTab[]
  activePath: string | null
}

/**
 * 关掉一个标签页之后的样子。
 *
 * 关掉的是当前这一个时，焦点交给**右邻**（没有右邻就交给左邻）—— 与浏览器标签页
 * 一致：连按几次关闭，看到的是同一批文件按打开顺序退出，而不是焦点来回跳。关的不是
 * 当前这一个时焦点不动（用户是在清理开多的标签页）。
 *
 * 路径不在时返回 null：调用方据此知道这一步什么都不用做。
 */
function closedTab(slice: CloseSlice, path: string): CloseSlice | null {
  const index = slice.tabs.findIndex((tab) => tab.path === path)
  if (index < 0) return null

  const tabs = slice.tabs.filter((tab) => tab.path !== path)
  if (slice.activePath !== path) return { tabs, activePath: slice.activePath }

  const next = tabs[index] ?? tabs[index - 1] ?? null
  return { tabs, activePath: next?.path ?? null }
}

/**
 * 从队首开始连续关掉那些**不需要用户决定**的标签页，停在第一个有未落盘改动的上面。
 *
 * 这就是「关标签是两步的」那件事：干净的直接关，脏的必须等一句回答。走队列而不是在
 * 每条动作里各分一次叉，是为了让「关一个 / 关闭其他 / 关闭全部 / 关闭未改动的」共用
 * 同一套收尾 —— 它们的差别只剩**入队哪些路径**。
 *
 * 队首那个已经不在标签数组里的（被别的路径顺手关掉了）直接出队：留着它只会让界面
 * 问一个已经没有的问题。
 */
function drainCloseQueue(
  slice: CloseSlice,
  queue: string[]
): CloseSlice & { closeQueue: string[] } {
  let current = slice
  let rest = queue

  while (rest.length > 0) {
    const head = rest[0]
    const tab = current.tabs.find((item) => item.path === head)

    if (!tab) {
      rest = rest.slice(1)
      continue
    }

    // 有未落盘的改动：停下来等用户回答（界面据队列非空画出那一问）
    if (tab.dirty) break

    current = closedTab(current, head) ?? current
    rest = rest.slice(1)
  }

  return { ...current, closeQueue: rest }
}

/**
 * 把一批路径接进关闭队列，然后按同一套规则往下走。
 *
 * 已经在队列里的路径不再接一次：连点两下关闭按钮不该问两遍同一件事。一个都没接上时
 * 返回空对象 —— 让 zustand 跳过这次通知，与 setDocument 那条早退同一个理由。
 */
function enqueueClose(state: EditorState, paths: readonly string[]): Partial<EditorState> {
  const queued = new Set(state.closeQueue)
  const additions = paths.filter((path) => !queued.has(path))
  if (additions.length === 0) return {}

  return drainCloseQueue(state, [...state.closeQueue, ...additions])
}

/** 当前标签页以外的全部标签页（「关闭其他」要关的就是这些） */
function othersOf(state: EditorState): string[] {
  return state.tabs.filter((tab) => tab.path !== state.activePath).map((tab) => tab.path)
}

/**
 * 关闭队列跟着一次改名走。
 *
 * 队列里存的是路径，而路径一变就再也对不上任何标签页了 —— 不跟着改的话，改名之后
 * 那一问会指向一个不存在的文件（队首成了「不在标签数组里」的那种，会被丢掉，
 * 于是用户刚决定要处理的标签页悄悄不问了）。
 *
 * 顺带去重：改名可能把两条并成一条（新名字本来就开着），队列里不该留着两份。
 */
function renameInQueue(queue: readonly string[], previousPath: string, nextPath: string): string[] {
  return [...new Set(queue.map((path) => (path === previousPath ? nextPath : path)))]
}

export const useEditorStore = create<EditorState>((set) => ({
  tabs: [],
  activePath: null,
  pendingDiff: null,
  closeQueue: [],

  openFile: (file) =>
    set((s) => {
      const existing = s.tabs.find((tab) => tab.path === file.path)
      const text = tabText(file.content, file.content)

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
                  ...text,
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
            ...text,
            refreshToken: 0
          }
        ]
      }
    }),

  setActive: (path) =>
    set((s) => (s.tabs.some((tab) => tab.path === path) ? { activePath: path } : {})),

  requestClose: (path) => set((s) => enqueueClose(s, [path])),

  requestCloseOthers: () => set((s) => (s.activePath === null ? {} : enqueueClose(s, othersOf(s)))),

  requestCloseSaved: () =>
    set((s) =>
      // 「关闭未改动的」永远不需要问：要关的那些本来就没有未落盘的内容
      enqueueClose(
        s,
        s.tabs.filter((tab) => !tab.dirty).map((tab) => tab.path)
      )
    ),

  requestCloseAll: () =>
    set((s) =>
      enqueueClose(
        s,
        s.tabs.map((tab) => tab.path)
      )
    ),

  finishClose: () =>
    set((s) => {
      const [head, ...rest] = s.closeQueue
      if (head === undefined) return {}

      // 先把队首那个真正关掉（用户已经决定「保存」或「不保存」了），再继续处理队列
      return drainCloseQueue(closedTab(s, head) ?? s, rest)
    }),

  cancelClose: () => set((s) => (s.closeQueue.length === 0 ? {} : { closeQueue: [] })),

  setDocument: (path, content) =>
    set((s) => {
      const index = s.tabs.findIndex((tab) => tab.path === path)
      if (index < 0) return {}

      const tab = s.tabs[index]

      /*
       * 正文一模一样时返回空对象。
       *
       * 这条不是省事的优化：`onDidChangeModelContent` 在**每一次按键**后都会触发，
       * 而这里每换一次引用，标签条、文件树与正打开着这一篇的表单都要白重渲染一遍。
       * Monaco 只在内容真的变了时才发这条通知，所以「走不到这里」的情形很少 ——
       * 但宿主自己写回 model 之后（表单改元数据）会补一次通知，那一次必须被它拦住。
       */
      if (tab.content === content) return {}

      const tabs = [...s.tabs]
      tabs[index] = { ...tab, ...tabText(content, tab.originalValue) }
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
      /**
       * 磁盘上的新内容同时是新基准**与**新正文：宿主（AI 插件）改写一个文件之后，
       * 用户看到的就该是改过的那一份。正文是不是也跟着换由调用方决定 —— 它先写
       * model，再走到这里；两个副本（model 与 store）因此落在同一份文字上。
       */
      tabs[index] = { ...tab, originalValue: content, ...tabText(content, content) }
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
          activePath: s.activePath === previousPath ? nextPath : s.activePath,
          closeQueue: renameInQueue(s.closeQueue, previousPath, nextPath)
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
        activePath: s.activePath === previousPath ? nextPath : s.activePath,
        closeQueue: renameInQueue(s.closeQueue, previousPath, nextPath)
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
      // 队列里那些已经不在了的路径一起摘掉：文件都被删了，没什么可问的了
      const closeQueue = s.closeQueue.filter((queued) => !gone.has(queued))

      // 焦点按 closedTab 的规则重新落地：删掉的若是当前这一个，交给它的右邻（没有就左邻）
      if (s.activePath && gone.has(s.activePath)) {
        // 位置在**原来那个数组**里算，再去掉之后的那一份里取邻居（与 closedTab 同一套算法）
        const index = s.tabs.findIndex((tab) => tab.path === s.activePath)
        const next = tabs[index] ?? tabs[index - 1] ?? null
        return { tabs, activePath: next?.path ?? null, closeQueue }
      }

      return { tabs, closeQueue }
    })

    return closed
  },

  showDiff: (original, modified) => set({ pendingDiff: { original, modified } }),
  clearDiff: () => set({ pendingDiff: null })
}))
