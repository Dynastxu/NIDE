import { JSX, useEffect, useRef } from 'react'
import { useT } from '@renderer/stores/i18n.store'

/**
 * 「更改需要重启 IDE，是否现在就重启？」
 *
 * 画成渲染进程里的浮层，而不是 `dialog.showMessageBox`：
 *
 * 1. 这个窗口是**无边框 + 自绘标题栏**的，一个原生对话框会带着系统的外观插进来，
 *    和旁边的自绘界面完全两套东西。
 * 2. 原生对话框是模态的、会阻塞主进程那侧的调用栈；而这个提示的时机在「提交
 *    设置」之后，主进程不该在这里被卡住。
 *
 * 它是**自带窗口按钮的窗口**里的一层遮罩，所以按 Esc 关掉是必须的 —— 自绘窗口
 * 没有系统菜单那种兜底出口。
 */
export function RestartDialog({
  onRestart,
  onLater
}: {
  /** 立即重启 —— 会重建主窗口 */
  onRestart: () => void
  /** 稍后 —— 只关掉提示，用户继续用当前这个窗口 */
  onLater: () => void
}): JSX.Element {
  const t = useT()
  const primaryRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onLater()
      // 回车落在「立即」上：这是用户主动改设置后得到的结果提示，
      // 不是危险操作（重启丢的是未保存的编辑器内容，那本来就是切语言等
      // 既有一切重启路径的代价，提示文案里也写明了）
      if (event.key === 'Enter') onRestart()
    }

    document.addEventListener('keydown', onKey)
    primaryRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [onRestart, onLater])

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="nide-restart-title"
        className="flex w-[380px] max-w-[90%] flex-col gap-3 rounded-lg border border-zinc-700 bg-zinc-800 p-5 shadow-2xl shadow-black/50"
      >
        <h2 id="nide-restart-title" className="text-sm font-medium text-zinc-100">
          {t('host.settings.restart.title')}
        </h2>
        <p className="text-xs leading-relaxed text-zinc-400">
          {t('host.settings.restart.message')}
        </p>

        <div className="mt-1 flex justify-end gap-2">
          <button
            ref={primaryRef}
            type="button"
            onClick={onRestart}
            className="rounded bg-blue-600 px-3.5 py-1 text-xs text-white transition-colors hover:bg-blue-500"
          >
            {t('host.settings.restart.now')}
          </button>
          <button
            type="button"
            onClick={onLater}
            className="rounded bg-zinc-700 px-3.5 py-1 text-xs text-zinc-100 transition-colors hover:bg-zinc-600"
          >
            {t('host.settings.restart.later')}
          </button>
        </div>
      </div>
    </div>
  )
}
