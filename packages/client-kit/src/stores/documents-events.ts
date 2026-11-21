type DocumentSavedListener = (path: string, content: string) => void

const listeners = new Set<DocumentSavedListener>()

/**
 * 「某个文档刚保存成功」的通知。
 *
 * 保存本身只发生在 editor-save；而保存之后要刷新什么（例如图鉴列表）属于别的域。
 * 让保存方直接 import 那些 store，会把「写盘」和「谁依赖写盘」焊死 —— explorer
 * 独立成包之后，这条反向依赖就会被门禁拦住。改成一条单向事件：
 *
 * - 保存方 `notifyDocumentSaved(path, content)`；
 * - 关心的域 `onDocumentSaved(listener)`，自己判断要不要刷新。
 *
 * 为什么不用 Cordis 的事件总线：这条通知只发生在渲染进程内、只有一个进程级监听集合，
 * 一个 20 行的 Set 比引入跨进程 / 跨插件的公共事件面更容易看清生命周期。
 */
export function onDocumentSaved(listener: DocumentSavedListener): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

/** 保存成功后调用；监听者抛错不影响其他监听者，也不影响保存结果。 */
export function notifyDocumentSaved(path: string, content: string): void {
  for (const listener of listeners) {
    try {
      listener(path, content)
    } catch (error) {
      console.error('[documents] saved listener failed', error)
    }
  }
}
