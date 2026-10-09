import { JSX, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'

/**
 * 通用二次确认框。
 *
 * 画成渲染进程里的浮层（并 portal 到 `document.body`），而不是
 * `dialog.showMessageBox`：
 *
 * 1. 宿主所有窗口都是**无边框 + 自绘标题栏**的，一个原生对话框会带着系统的外观
 *    插进来，和旁边的自绘界面完全两套东西。
 * 2. 原生对话框是模态的、会阻塞主进程那侧的调用栈；而这个提示的时机通常在
 *    「用户点了某个菜单项」之后，主进程不该在这里被卡住。
 *
 * portal 的理由是**位置**：调用点常常在标题栏里（`absolute inset-0` 会被那条
 * 32px 高的标题栏裁掉），而且标题栏整条是拖拽区 —— 挂到 body 之后，浮层既盖得住
 * 整个窗口，也不继承 `-webkit-app-region: drag`。
 *
 * 文案由调用方传入（已经过 t()），这一层不认识任何业务词条：确认框里放什么话是
 * 调用方的知识。
 */
export interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  /**
   * 破坏性操作（退出应用、关掉当前项目）。
   *
   * 影响两处：确认按钮用红色，以及**初始焦点落在「取消」上** —— 破坏性操作不该让
   * 回车直接落在它上面（与主进程切语言确认框的同一条理由）。
   */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps): JSX.Element {
  const titleId = useId()
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCancel()
        return
      }

      // 非破坏性操作：回车就是「确认」，这也是原生对话框的默认按钮语义
      if (event.key === 'Enter' && !danger) onConfirm()
    }

    document.addEventListener('keydown', onKey)
    // 焦点必须在浮层里：无边框窗口没有系统菜单那种兜底出口，键盘用户要有地方落
    const target = danger ? cancelRef.current : confirmRef.current
    target?.focus()

    return () => document.removeEventListener('keydown', onKey)
  }, [danger, onConfirm, onCancel])

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex w-[400px] max-w-[90%] flex-col gap-3 rounded-lg border border-zinc-700 bg-zinc-800 p-5 shadow-2xl shadow-black/50"
      >
        <h2 id={titleId} className="text-sm font-medium text-zinc-100">
          {title}
        </h2>
        <p className="text-xs leading-relaxed text-zinc-400">{message}</p>

        <div className="mt-1 flex justify-end gap-2">
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={[
              'rounded px-3.5 py-1 text-xs text-white transition-colors',
              danger ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'
            ].join(' ')}
          >
            {confirmLabel}
          </button>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded bg-zinc-700 px-3.5 py-1 text-xs text-zinc-100 transition-colors hover:bg-zinc-600"
          >
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
