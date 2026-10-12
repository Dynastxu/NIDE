import { JSX, useCallback, useEffect, useState, type ReactNode } from 'react'
import { ConfirmDialog } from '@renderer/ui/ConfirmDialog'
import type { ConfirmRequest } from '@shared/confirm'

/**
 * 宿主（主进程）发起的二次确认在渲染进程的落点。
 *
 * 包在**每一种**窗口的根组件外面（见 main.tsx）：确认问在哪一个窗口上，取决于谁
 * 发起了那个动作 —— 删除问在文件树那个窗口，重启问在设置窗口，关窗问在被关的那个
 * 窗口。所以每一扇窗都得有一个能接住它的地方。
 *
 * ## 它刻意很薄
 *
 * 这一层不知道任何业务：不知道自己在替哪个动作问，也不知道文案该写什么 —— 那两件事
 * 都在主进程（见 main/confirm.ts）。它只做三件事：
 *
 * 1. 订阅主进程的询问，排进队列；
 * 2. 把队首画成通用确认框（`ConfirmDialog`：Esc、焦点、危险配色都在那一层）；
 * 3. 把用户的回答按原样的编号送回去。
 *
 * 「排队」不是洁癖：主进程可能同时问着两件事（比如删一半、用户又去关了项目），而
 * 一次画两个浮层叠在一起，用户根本分不清哪个回答对应哪件事。
 */
export function ConfirmHost({ children }: { children: ReactNode }): JSX.Element {
  /** 等着用户回答的询问，队首那个正在显示 */
  const [queue, setQueue] = useState<ConfirmRequest[]>([])

  useEffect(() => {
    const subscription = window.hostAPI.confirm.onRequest((request) => {
      setQueue((current) => [...current, request])
    })

    return () => subscription.dispose()
  }, [])

  const current = queue[0] ?? null

  /**
   * 回答队首那一问。
   *
   * 先把回答送回去、再把它从队列里摘掉：主进程收到回答就会往下走（比如拆掉窗口），
   * 而摘队列只是本地的事，谁先谁后都不影响正确性。摘的时候按 **id** 过滤而不是
   * 直接切掉队首 —— 状态更新函数必须是纯的（StrictMode 下会被调用两次），按 id
   * 过滤重放多少次结果都一样。
   */
  const answer = useCallback(
    (confirmed: boolean) => {
      if (!current) return

      window.hostAPI.confirm.respond(current.id, confirmed)
      setQueue((waiting) => waiting.filter((item) => item.id !== current.id))
    },
    [current]
  )

  return (
    <>
      {children}

      {/*
        key 绑编号：换一问时重新挂载，输入焦点与 Esc 监听都跟着重来一遍 ——
        否则第二问会带着上一问的焦点状态出现。
      */}
      {current && (
        <ConfirmDialog
          key={current.id}
          danger={current.danger}
          title={current.title}
          message={current.message}
          confirmLabel={current.confirmLabel}
          cancelLabel={current.cancelLabel}
          onConfirm={() => answer(true)}
          onCancel={() => answer(false)}
        />
      )}
    </>
  )
}
