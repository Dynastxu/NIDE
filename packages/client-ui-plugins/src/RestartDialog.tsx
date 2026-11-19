import { JSX } from 'react'
import { useT } from '@nide/client-kit/stores/i18n.store'
import { ConfirmDialog } from '@nide/client-kit/ui/ConfirmDialog'

/**
 * 「更改需要重启 IDE，是否现在就重启？」
 *
 * 只是把词条接到通用确认框（`@nide/client-kit/ui/ConfirmDialog`）上 —— 浮层、Esc、
 * 焦点这些事在那一层，这里只负责「问什么、按钮叫什么」。
 *
 * 它**不是**破坏性操作：重启丢的是未保存的编辑器内容，而那是切语言等既有一切重启
 * 路径的代价，文案里也写明了，所以确认按钮用常规配色、回车即确认。
 *
 * 它问的是「这一次改动的意图」（要不要现在重启），所以调用方紧接着发的重启请求带
 * `{ confirm: false }` —— 那一句声明「用户意图我已经问清楚了」，免得主进程再问一遍
 * （见 main/confirm.ts 的 restart 规格）。
 */
export function RestartDialog({
  onRestart,
  onLater
}: {
  /** 立即重启 —— 会重建根窗口 */
  onRestart: () => void
  /** 稍后 —— 只关掉提示，用户继续用当前这个窗口 */
  onLater: () => void
}): JSX.Element {
  const t = useT()

  return (
    <ConfirmDialog
      title={t('host.settings.restart.title')}
      message={t('host.settings.restart.message')}
      confirmLabel={t('host.settings.restart.now')}
      cancelLabel={t('host.settings.restart.later')}
      onConfirm={onRestart}
      onCancel={onLater}
    />
  )
}
