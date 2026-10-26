import { writeChapterMetadata, type ChapterMetadata } from '@shared/project'
import { modelFor, writeModelSilently } from '@renderer/editor/model-registry'
import { useEditorStore } from '@nide/client-kit/stores/editor.store'

/**
 * 把**元数据**的改动写回正在编辑的那一篇。
 *
 * 表单改的是 frontmatter，而正文在别处（正文是用户在同一份文稿里写的字），所以这里
 * 必须只替换开头那一块、正文一个字都不碰（见 shared/project 的 writeChapterMetadata）。
 *
 * ## 为什么经 model 而不是直接改 store
 *
 * 正文只有一处来源：Monaco 的 model（见 editor/model-registry）。store 里的 `content`
 * 是它推过来的一个副本，直接改那份副本就会造出第二个真相 —— 下一次用户在编辑器里
 * 敲一个字，model 里的旧正文就会把元数据的改动整块盖掉。
 *
 * ## 为什么写入要「静默」
 *
 * `writeModelSilently` 用 `pushEditOperations` 写（保留撤销历史：表单改出来的
 * frontmatter 也能被 Ctrl+Z 退回去），并且让这次写入**不被当成用户的编辑** ——
 * 否则「写入 -> 触发 change -> 又写回 store -> 再渲染 -> 又写入」会绕成环。
 * 代价是 store 不会自己知道，所以这里写完必须补一次 `setDocument`。
 */
export function applyChapterMetadata(
  path: string,
  metadata: ChapterMetadata,
  syncing: { current: boolean }
): void {
  const model = modelFor(path)
  // 标签页已经关掉、或者 model 还没建出来：这次改动没有落点，直接丢掉
  if (!model) return

  const before = model.getValue()
  const after = writeChapterMetadata(before, metadata)

  /**
   * 一个字都没变时什么都不做。
   *
   * 表单每次 `commit` 都会走到这里（用户敲一个字符算一次），而多数时候 frontmatter
   * 的形状没变（例如他还在敲索引、值还不合法）。换掉 model 的值会推一次撤销栈，
   * 于是「改了又改回去」变成好几步 Ctrl+Z。
   */
  if (after === before) return

  writeModelSilently(model, after, syncing)

  useEditorStore.getState().setDocument(path, after)
}
