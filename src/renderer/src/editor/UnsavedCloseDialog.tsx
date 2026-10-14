import { JSX, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '@renderer/stores/i18n.store'

/**
 * 关掉一个**还没保存**的标签页时问的那一句。
 *
 * ```
 *   ┌──────────────────────────────────────────────┐
 *   │ 「第一章.md」有未保存的改动                   │
 *   │ 要保存这些改动吗？不保存的话，关掉这个标签页   │
 *   │ 就会丢掉它们。                                │
 *   │                        [保存] [不保存] [取消] │
 *   └──────────────────────────────────────────────┘
 * ```
 *
 * ## 为什么不是 ui/ConfirmDialog
 *
 * 那一层是**两个**按钮的一问一答（确认 / 取消），而这里要问的是**三选一**：
 * 保存、不保存、取消。「不保存」不是「取消」—— 前者是「关掉，丢掉改动」，后者是
 * 「什么都别做，标签页留着」。少一个按钮就只能把两种意思压进同一个答案里，而其中
 * 一定有一种是错的。
 *
 * ## 为什么不是主进程问的（行为级二次确认）
 *
 * 那一套问的是**动作的性质**（删除、退出这类不可撤销的动作），问在 IPC 出口上，
 * 所以谁发起都算数。而「关掉一个标签页」根本不是一次 IPC：它是渲染进程本地的一次
 * 状态变化，主进程看不见也不该看见。真正会走到主进程的那一步（保存）由主进程自己
 * 校验 —— 它不需要为「要不要保存」替用户拿主意。
 *
 * ## 焦点
 *
 * 初始焦点在**「保存」**上（回车 = 保存），Esc = 取消。这与 ConfirmDialog 里破坏性
 * 动作把焦点放在「取消」上是同一条理由的反面：这里最想让人做的是把改动留下来，
 * 而「丢掉改动」需要多走一步才能点到。
 *
 * 保存失败时浮层**留在原地**，把原因写在按钮上方 —— 磁盘满了、文件被别的程序独占，
 * 都是改一下状态就能重试的，把浮层关掉等于让用户自己再找一次关闭按钮。
 */
export interface UnsavedCloseDialogProps {
  /** 显示名（路径最后一段）。完整路径太长，而这一问要的是让人认出是哪个文件 */
  name: string
  /**
   * 保存。返回 null 表示成功（调用方随即把标签页关掉，这个浮层跟着卸载），
   * 返回一句话表示失败 —— 那句话显示在按钮上方。
   */
  onSave: () => Promise<string | null>
  /** 不保存，直接关掉（丢掉这些改动） */
  onDiscard: () => void
  /** 取消：什么都不做，标签页留着 */
  onCancel: () => void
}

export function UnsavedCloseDialog({
  name,
  onSave,
  onDiscard,
  onCancel
}: UnsavedCloseDialogProps): JSX.Element {
  const t = useT()
  const titleId = useId()
  const saveRef = useRef<HTMLButtonElement>(null)
  /**
   * 正在保存。
   *
   * 同时用 ref 与 state 是刻意的，两者管的不是同一件事：**state 管界面**（按钮置灰），
   * **ref 管重入**。回车那一下会走两条路 —— document 上这条监听，以及焦点所在的那个
   * 「保存」按钮被浏览器原生激活所触发的 click；而 click 处理函数是**上一帧**渲染出来
   * 的那一份闭包，那里面 `busy` 还是 false。只有 ref 能挡住它。
   */
  const busyRef = useRef(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    saveRef.current?.focus()
  }, [])

  const submit = async (): Promise<void> => {
    if (busyRef.current) return

    busyRef.current = true
    setBusy(true)
    setFailure(null)
    try {
      const message = await onSave()
      // 成功时调用方会把整个浮层卸掉，这里的 setState 落在一个已卸载的组件上也无妨
      if (message) setFailure(message)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  /**
   * 键盘：回车 = 保存，Esc = 取消。
   *
   * 没有依赖数组是刻意的：这一条每次渲染都重新挂一遍，为的是它读到的永远是最新的
   * `onCancel` 与 `submit`。保存进行中时两个键都不响应（按钮此刻也是灰的）——
   * 那一问正在被回答，再按一次只可能得到自相矛盾的结论。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (busyRef.current) return

      if (event.key === 'Escape') {
        onCancel()
        return
      }

      // 回车就是「保存」，与初始焦点落在「保存」按钮上一致
      if (event.key === 'Enter') void submit()
    }

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex w-[420px] max-w-[90%] flex-col gap-3 rounded-lg border border-zinc-700 bg-zinc-800 p-5 shadow-2xl shadow-black/50"
      >
        <h2 id={titleId} className="text-sm font-medium text-zinc-100">
          {t('host.editor.unsaved.title', { name })}
        </h2>
        <p className="text-xs leading-relaxed text-zinc-400">{t('host.editor.unsaved.message')}</p>

        {failure && (
          <p role="alert" className="text-[11px] text-red-400">
            {failure}
          </p>
        )}

        <div className="mt-1 flex justify-end gap-2">
          <button
            ref={saveRef}
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="rounded bg-blue-600 px-3.5 py-1 text-xs text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
          >
            {t('host.editor.save')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDiscard}
            className="rounded bg-zinc-700 px-3.5 py-1 text-xs text-zinc-100 transition-colors hover:bg-zinc-600 disabled:cursor-not-allowed disabled:text-zinc-500"
          >
            {t('host.editor.unsaved.discard')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded bg-zinc-700 px-3.5 py-1 text-xs text-zinc-100 transition-colors hover:bg-zinc-600 disabled:cursor-not-allowed disabled:text-zinc-500"
          >
            {t('host.dialog.cancel')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
