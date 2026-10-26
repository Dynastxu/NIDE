import { formatForeshadowingEntry, type ForeshadowingMetadata } from '@shared/project'
import { ensureModel, modelFor, writeModelSilently } from '@renderer/editor/model-registry'
import { useEditorStore } from '@nide/client-kit/stores/editor.store'

/**
 * 伏笔表单与文件之间的那一步：把表单里的改动写回正在编辑的那一份 yml。
 *
 * 与 `chapter-metadata.ts` / `gallery-metadata.ts` 严格成对，连理由都一一对应：
 *
 * - **经 model 而不是直接改 store**：正文只有一处来源，就是它的 model（见
 *   editor/model-registry）。store 里的 `content` 是它推过来的副本，直接改那份副本会
 *   造出第二个真相 —— 下一次保存（editor-save 读的正是 model）写下去的会是改动之前
 *   的那一份。
 * - **写入要「静默」**：`writeModelSilently` 用 `pushEditOperations` 写（保留撤销历史：
 *   表单改出来的字段也能被 Ctrl+Z 退回去），并且让这次写入**不被当成用户的编辑** ——
 *   否则「写入 -> 触发 change -> 又写回 store -> 再渲染 -> 又写入」会绕成环。代价是
 *   store 不会自己知道，所以这里写完必须补一次 `setDocument`。
 *
 * 与章节那一层的差别有两处：伏笔的整份文件就是属性（没有正文可保留，写回的是整份
 * yml），而且表单**没有正文编辑器** —— 所以 model 得由表单自己建出来。保存读的是
 * model，而这里没有哪个 MonacoHost 会顺手建它。
 */

/**
 * 让这一篇的 model 存在，并与标签页上那份正文对齐。
 *
 * 建：切到表单模式时建一次，`Ctrl+S` 才有东西可读；
 * 对齐：从文件树里重新打开同一个文件时，store 里的正文会被换成磁盘上那一份，而 model
 * 里可能还留着这次会话改过的东西。章节表单不需要这一步，因为它的 MonacoHost 顺手做了
 * 同一件事（见 EditorPanes 的「宿主写入」），而这里没有那个组件。
 */
export function syncForeshadowingForm(
  tab: { path: string; language: string; originalValue: string; content: string },
  syncing: { current: boolean }
): void {
  const model = ensureModel(tab)
  if (model.getValue() === tab.content) return

  writeModelSilently(model, tab.content, syncing)
}

/**
 * 元数据 -> 整份 yml。
 *
 * 伏笔没有正文，所以写回的就是整份文件（见 shared/project 的 formatForeshadowingEntry）。
 * 文本一个字都没变时什么都不做：表单每次提交都会走到这里（用户敲一个字符算一次），
 * 而换掉 model 的值会推一次撤销栈。
 */
export function applyForeshadowingMetadata(
  path: string,
  metadata: ForeshadowingMetadata,
  syncing: { current: boolean }
): void {
  const model = modelFor(path)
  // 标签页已经关掉、或者 model 还没建出来：这次改动没有落点，直接丢掉
  if (!model) return

  const before = model.getValue()
  const after = formatForeshadowingEntry(metadata)

  if (after === before) return

  writeModelSilently(model, after, syncing)
  useEditorStore.getState().setDocument(path, after)
}
