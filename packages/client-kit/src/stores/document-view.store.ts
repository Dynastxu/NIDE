import { create } from 'zustand'

/**
 * 一个 Markdown 文件在哪个视图模式下打开。
 *
 * | 取值     | 界面                                   |
 * | -------- | -------------------------------------- |
 * | `text`   | 只有文本编辑器（整个文件，含 frontmatter） |
 * | `form`   | 章节表单：元数据字段 + 正文编辑器        |
 * | `split`  | 左文本、右预览                          |
 * | `preview`| 只有预览                                |
 *
 * ## 为什么按路径记
 *
 * 模式是**每个文件**的状态，不是「编辑器现在是什么样」：用户给第 3 章选了预览、又去
 * 看第 4 章的正文，回来时第 3 章不该已经变回默认。按路径记一份表，切标签页天然保留
 * 各自的选择。
 *
 * ## 为什么不做持久化
 *
 * 它只活在这个窗口的这次会话里：换项目会重建窗口（见 shared/project），模式跟着归零。
 * 一个「上次用的是表单」这种偏好，等真的有人提出要它时再落盘 —— 现在落盘只会多一份
 * 要跟着 schema 走的磁盘数据。
 *
 * 表里**没有**某条路径时由界面按默认值决定（见 defaultDocumentMode）：Markdown 默认
 * 表单、认不出类别的默认预览、其余一律纯文本。默认值不进表，所以「用户没选过」与
 * 「用户选了一个恰好等于默认值的模式」在行为上没有区别 —— 那正是想要的。
 */
export type DocumentViewMode = 'text' | 'form' | 'split' | 'preview'

interface DocumentViewState {
  /** 路径 -> 这一篇当前的视图模式。没有条目表示用户还没选过 */
  modes: Record<string, DocumentViewMode>
  /** 与当前值相同时返回原 state：点已经选中的那个按钮不该引起任何重渲染 */
  setMode: (path: string, mode: DocumentViewMode) => void
  /** 标签页关掉之后把这一条丢掉（与 model 的释放同一个时机） */
  forget: (paths: ReadonlySet<string>) => void
}

export const useDocumentViewStore = create<DocumentViewState>((set) => ({
  modes: {},

  setMode: (path, mode) =>
    set((s) => (s.modes[path] === mode ? s : { modes: { ...s.modes, [path]: mode } })),

  forget: (paths) =>
    set((s) => {
      const modes: Record<string, DocumentViewMode> = {}
      let dropped = false

      for (const [path, mode] of Object.entries(s.modes)) {
        if (paths.has(path)) {
          modes[path] = mode
          continue
        }
        dropped = true
      }

      // 一条都没丢时返回原 state：让 zustand 跳过这次通知
      return dropped ? { modes } : s
    })
}))
