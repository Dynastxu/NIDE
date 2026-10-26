import { formatGalleryEntry, serializeGalleryConfig } from '@nide/contracts/project'
import {
  ensureModel,
  modelFor,
  writeModelSilently
} from '@nide/client-ui-main/editor/model-registry'
import { useEditorStore } from '@nide/client-kit/stores/editor.store'

/**
 * 图鉴表单与文件之间的那一步：把表单里的改动写回正在编辑的那份 yml。
 *
 * 与 `chapter-metadata.ts` / `chapter-body.ts` 严格成对，连理由都一一对应：
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
 * 与章节那一层唯一的差别是**整份文件都是属性**：图鉴的条目与字段表都没有「正文」，
 * 所以写回的是整份文本（`formatGalleryEntry` / `serializeGalleryConfig`），没有
 * 「只换开头那一段」这一档。
 */

/**
 * 让这一篇的 model 存在，并与标签页上那份正文对齐。
 *
 * 表单模式里**没有 Monaco 编辑器**（图鉴的整份文件就是字段，不需要再摆一个编辑器），
 * 而保存读的是 model（见 editor-save.ts）—— 所以 model 必须有人建出来，而且内容要与
 * 屏幕上显示的那一份一致：
 *
 * - 建：切到表单模式时建一次，`Ctrl+S` 才有东西可读；
 * - 对齐：从文件树里重新打开同一个文件时，store 里的正文会被换成磁盘上那一份，而
 *   model 里可能还留着这次会话改过的东西。章节表单不需要这一步，因为它的 MonacoHost
 *   顺手做了同一件事（见 EditorPanes 的「宿主写入」），而这里没有那个组件。
 */
export function syncGalleryForm(
  tab: { path: string; language: string; originalValue: string; content: string },
  syncing: { current: boolean }
): void {
  const model = ensureModel(tab)
  if (model.getValue() === tab.content) return

  writeModelSilently(model, tab.content, syncing)
}

/**
 * 字段值 -> 整份 yml。
 *
 * `order` 是界面上的字段顺序（图鉴配置的字段在前、文件里多出来的跟在后面）：写出去
 * 的顺序因此与用户看到的一致，而不是对象键的插入顺序。
 */
export function applyGalleryEntryValues(
  path: string,
  values: Readonly<Record<string, string>>,
  order: readonly string[],
  syncing: { current: boolean }
): void {
  applyGalleryText(path, formatGalleryEntry(values, order), syncing)
}

/** 字段表 -> `config.yml` 的整份文本 */
export function applyGalleryConfig(
  path: string,
  fields: readonly string[],
  syncing: { current: boolean }
): void {
  applyGalleryText(path, serializeGalleryConfig({ fields: [...fields] }), syncing)
}

/**
 * 一次静默写入：把算好的整份文本放进 model，再补一次 `setDocument`。
 *
 * 文本一个字都没变时什么都不做。表单每次提交都会走到这里（用户敲一个字符算一次），
 * 而多数时候算出来的文本与手上那份相同（例如他还在敲索引、值还不合法）—— 换掉 model
 * 的值会推一次撤销栈，于是「改了又改回去」变成好几步 Ctrl+Z。
 */
function applyGalleryText(path: string, after: string, syncing: { current: boolean }): void {
  const model = modelFor(path)
  // 标签页已经关掉、或者 model 还没建出来：这次改动没有落点，直接丢掉
  if (!model) return

  if (model.getValue() === after) return

  writeModelSilently(model, after, syncing)
  useEditorStore.getState().setDocument(path, after)
}
