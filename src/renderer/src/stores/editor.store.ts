import { create } from 'zustand'

interface EditorState {
  /** 当前打开的文件路径 */
  currentFile: string | null
  /** 当前编辑器内容（用于 Diff 对比时的原始值） */
  currentContent: string
  /** 需要展示的 Diff（AI 提议修改时触发） */
  pendingDiff: { original: string; modified: string } | null

  setCurrentFile: (path: string | null) => void
  setCurrentContent: (content: string) => void
  showDiff: (original: string, modified: string) => void
  clearDiff: () => void
}

export const useEditorStore = create<EditorState>((set) => ({
  currentFile: null,
  currentContent: '',
  pendingDiff: null,

  setCurrentFile: (path) => set({ currentFile: path }),
  setCurrentContent: (content) => set({ currentContent: content }),
  showDiff: (original, modified) => set({ pendingDiff: { original, modified } }),
  clearDiff: () => set({ pendingDiff: null })
}))
