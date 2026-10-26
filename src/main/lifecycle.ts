import { app, BrowserWindow } from 'electron'
import { confirmRequested } from '@nide/contracts/confirm'
import { CONFIRM_SPECS, askConfirmation, canAskIn } from './confirm'
import { loggerFor } from './logger'

const logger = loggerFor('lifecycle')

/**
 * 应用的两条「关门」路径：退出应用（`before-quit`）与关闭根窗口（窗口的 `close`）。
 *
 * 这两件事分量一样 —— Windows / Linux 上最后一个窗口关掉，进程就结束了 —— 所以
 * 它们**共用同一个问题**，都在这里问。放在主进程的另一个理由是没有第二条路可走：
 * 自绘的 ✕、Alt+F4、任务栏的「关闭窗口」最后都落在窗口的 `close` 事件上，
 * 系统级的退出（macOS 的 ⌘Q、Dock、会话结束）落在 `before-quit` 上。
 *
 * ## 一个标志管两件事
 *
 * `quitting` 的含义是「用户已经就『这个应用要关掉』给过答案了」。它同时起到两个
 * 作用：`before-quit` 不再问第二遍（同意之后我们自己还会再调一次 `app.quit()`），
 * 退出流程开始后拆窗口时也不再逐窗问一遍。
 *
 * ## 没有窗口可问时放行
 *
 * 这是本项目里**唯一**「问不出去就默认同意」的地方，理由是另一种做法会留下一个
 * 没有出口的进程：`window-all-closed` 那条路（见 main/index.ts）是在所有窗口都没了
 * 之后才调 `app.quit()` 的，此时没有任何窗口能画浮层，再拦一次就永远退不掉。
 * 何况那个时刻已经没有任何东西可以丢了 —— 用户刚刚亲手关掉了最后一个窗口。
 */

/** 用户已经就「关掉这个应用」给过答案（或调用方显式声明问过了） */
let quitting = false

/** 正在等用户回答「退出」那一问。期间再来的退出请求不再开第二个确认框 */
let quitPromptPending = false

/** 正在等用户回答「关这个窗口」的那些窗口。按 id 记，窗口没了就随之失效 */
const closePromptPending = new Set<number>()

/**
 * 请求退出应用（标题栏「文件 -> 退出」走这里）。
 *
 * 自己不问：真正的关口是 `before-quit`，那一个口子同时管住菜单退出、⌘Q 与
 * 关掉最后一个窗口之后的自动退出。这里只负责把「调用方已经问过了」这个事实
 * 转达给那道门。
 */
export function requestQuit(options: unknown): void {
  if (!confirmRequested(options)) {
    quitting = true
    logger.info('Quit approved by the caller; not asking again')
  }
  app.quit()
}

/**
 * 装上退出确认 —— 在 `main/index.ts` 里注册一次。
 *
 * `before-quit` 是「应用要退出了」唯一的汇聚点，所以确认问在这里而不是问在
 * `host:quit-app` 那条通道上：从菜单退、从 ⌘Q 退、从 Dock 退都会经过这道门。
 */
export function installQuitGate(): void {
  app.on('before-quit', (event) => {
    if (quitting) return

    const window = askableWindow()
    if (!window) {
      logger.info('No window can be asked; letting the quit through')
      quitting = true
      return
    }

    // 两种情形都要拦住这一次退出：正在等回答，以及接下来要去问
    event.preventDefault()

    if (quitPromptPending) return
    quitPromptPending = true

    void askConfirmation(window, CONFIRM_SPECS.quit).then((confirmed) => {
      quitPromptPending = false
      if (!confirmed) {
        logger.info('Quit cancelled by the user')
        return
      }

      quitting = true
      app.quit()
    })
  })
}

/**
 * 给一个窗口装上关窗确认。
 *
 * 只有**根窗口**（主窗口 / 欢迎窗口）问：设置窗口是挂在根窗口下面的附属窗口，
 * 关掉它不损失任何东西，而「翻设置时随手关掉它」是最常见的动作之一。
 *
 * @param root 这个窗口是不是根窗口
 */
export function gateWindowClose(window: BrowserWindow, root: boolean): void {
  if (!root) return

  /**
   * id 在**挂监听时**取一次。
   *
   * 后面用它做两件事：认「这个窗口是不是已经有一问挂着」，以及注销那一问。窗口被
   * 拆掉之后 `window.id` 就未必读得出来了（销毁的对象按定义不该再被碰），而这一对
   * 读写都发生在「窗口可能已经没了」的时刻。
   */
  const windowId = window.id

  window.on('close', (event) => {
    // 退出流程正在拆窗口，用户在「退出」那一问里已经答过了
    if (quitting) return
    // 渲染进程已经不在了：问不出去，也绝不能因此把窗口卡住关不掉
    if (!canAskIn(window)) return

    // 已经有一问挂着：再点一次 ✕ 不该叠出第二个确认框
    event.preventDefault()
    if (closePromptPending.has(windowId)) return

    closePromptPending.add(windowId)
    void askConfirmation(window, CONFIRM_SPECS.closeWindow).then((confirmed) => {
      closePromptPending.delete(windowId)
      if (!confirmed) {
        logger.info('Window close cancelled by the user')
        return
      }

      /**
       * 用 `destroy()` 而不是再调一次 `close()`：后者会重新走一遍这个监听器，
       * 又摆出一个确认框。`destroy()` 是「已经定了，直接拆」，与 window.ts 里
       * 重建根窗口、回退欢迎窗口用的是同一种拆法。
       */
      if (!window.isDestroyed()) window.destroy()
    })
  })
}

/** 找一扇能画确认框的窗口：优先前台那个，退而求其次找任意一个还活着的 */
function askableWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && canAskIn(focused)) return focused

  return BrowserWindow.getAllWindows().find(canAskIn) ?? null
}
