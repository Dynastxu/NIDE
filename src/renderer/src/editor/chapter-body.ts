import { writeChapterBody } from '@shared/project'
import { modelFor, writeModelSilently } from '@renderer/editor/model-registry'
import { useEditorStore } from '@nide/client-kit/stores/editor.store'

/**
 * 把**正文**的改动写回正在编辑的那一篇。
 *
 * 表单模式里的正文编辑器绑的是**只有正文**的那一份 model（见 model-registry 的
 * ensureBodyModel），而用户改的是一个文件 —— 所以这里必须把改过的正文接回整篇：
 * frontmatter 一个字都不碰（见 shared/project 的 writeChapterBody）。
 *
 * 与 editor/chapter-metadata.ts 严格成对，连理由都一一对应：
 *
 * - **经 model 而不是直接改 store**：整篇正文只有一处来源，就是它的 model。store 里的
 *   `content` 是它推过来的副本，直接改那份副本会造出第二个真相 —— 下一次保存
 *   （editor-save 读的正是 model）写下去的会是编辑之前的正文。
 * - **写入要「静默」**：`writeModelSilently` 用 `pushEditOperations` 写（保留撤销历史），
 *   并且让这次写入不被当成用户的编辑，否则「写入 -> 触发 change -> 又写回 store ->
 *   再渲染 -> 又写入」会绕成环。代价是 store 不会自己知道，所以这里写完必须补一次
 *   `setDocument`。
 */
export function applyChapterBody(path: string, body: string, syncing: { current: boolean }): void {
  const model = modelFor(path)
  // 标签页已经关掉、或者整篇那份 model 还没建出来：这次改动没有落点，直接丢掉
  if (!model) return

  const before = model.getValue()
  const after = writeChapterBody(before, body)

  /**
   * 接回去之后整篇一个字都没变时什么都不做。
   *
   * 写一次就是一次撤销栈的推进（`pushEditOperations` 每次调用都是一个撤销点），而没有
   * 变的东西不该在历史里留下一步 —— 用户按下 Ctrl+Z 时该退掉他真正敲下的那一下。
   */
  if (after === before) return

  writeModelSilently(model, after, syncing)

  useEditorStore.getState().setDocument(path, after)
}
