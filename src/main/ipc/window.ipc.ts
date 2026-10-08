import { BrowserWindow, Menu, ipcMain } from 'electron'
import { WINDOW_CHANNELS, isWindowType, type WindowAction, type WindowState } from '@shared/window'

/**
 * 窗口控制通道。
 *
 * 窗口是无边框的（见 window.ts），最小化 / 最大化 / 关闭全得由渲染进程发起，
 * 所以这三个动作就是自定义标题栏的**全部后端**。标题栏组件不关心里面怎么实现，
 * 它只发动作、收状态。
 */

/**
 * 「打开哪个窗口」由启动方注入，而不是在这里 import window.ts。
 *
 * window.ts 要 import 本文件的 trackWindowState，本文件再去 import 它的
 * createSettingsWindow 就是一条**循环依赖**。改成注入之后依赖是单向的，
 * 新增窗口种类时也不会再往这个文件里加 import。
 */
let windowOpeners: Partial<Record<string, () => void>> = {}

/**
 * 「重启应用」的实现也由启动方注入，理由和上面一样：它是 window.ts 的
 * recreateMainWindow，而本文件已经被 window.ts 依赖了，反向再 import 就是循环。
 */
let restartApp: (() => void) | null = null

export function registerWindowActions(actions: {
  openers: Partial<Record<string, () => void>>
  restart: () => void
}): void {
  windowOpeners = actions.openers
  restartApp = actions.restart
}

function stateOf(window: BrowserWindow): WindowState {
  return { maximized: window.isMaximized(), focused: window.isFocused() }
}

/**
 * 把窗口状态推给该窗口的渲染进程。
 *
 * 只推给发起方自己，不做全局广播：每个窗口的按钮只反映自己。
 *
 * 刻意不导出：唯一该调用的地方就是 trackWindowState。开口子出去，早晚会有人
 * 拿它去广播「别的窗口」的状态，而窗口按钮只认自己那一个。
 */
function broadcastWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  const { webContents: wc } = window
  if (wc.isDestroyed()) return
  wc.send(WINDOW_CHANNELS.stateChanged, stateOf(window))
}

/**
 * 给一个新窗口挂上状态上报。
 *
 * 三个事件缺一不可：
 * - maximize / unmaximize：按钮要在「最大化」和「还原」两个图标之间切换
 * - focus / blur：自绘按钮要在窗口失焦时变灰（原生按钮由系统负责，自绘得自己补）
 *
 * resize 事件**没有**挂：拖动边框改变尺寸不会改变最大化状态，而 isMaximized()
 * 在拖动过程中的取值依赖平台，反而会闪。Windows 上从最大化状态拖拽还原窗口
 * 会同时触发 unmaximize，已经覆盖到了。
 */
export function trackWindowState(window: BrowserWindow): void {
  const notify = (): void => broadcastWindowState(window)

  window.on('maximize', notify)
  window.on('unmaximize', notify)
  window.on('focus', notify)
  window.on('blur', notify)
}

export function registerWindowIPC(): void {
  ipcMain.handle(WINDOW_CHANNELS.state, (event): WindowState | null => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return window ? stateOf(window) : null
  })

  /**
   * 同步版本，**只给启动时那一次**用。
   *
   * 异步那条路上，标题栏第一帧拿不到 maximized，会把「最大化」图标画成
   * 「还原」再跳一下 —— 一帧的错位肉眼可见。同步 IPC 在这里的代价是
   * 一次几毫秒的阻塞，换来首帧就是对的，值得。
   *
   * 刻意限制成只读：写操作（最小化/关闭）一律走异步那条，绝不能阻塞渲染。
   */
  ipcMain.on(WINDOW_CHANNELS.stateSync, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    event.returnValue = window ? stateOf(window) : null
  })

  ipcMain.on(WINDOW_CHANNELS.action, (event, action: unknown): void => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return

    // 通道进来的是不可信数据：动作名对不上就丢掉，不要拿它去调 API
    switch (action as WindowAction) {
      case 'minimize':
        window.minimize()
        break
      case 'toggleMaximize':
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
        break
      case 'close':
        window.close()
        break
      case 'showSystemMenu':
        // 自绘标题栏上没有系统图标，系统菜单只能从标题栏右键唤出。
        // 菜单一旦弹出就是模态的，不需要我们再等它关闭。
        Menu.getApplicationMenu()?.popup({ window })
        break
      default:
        console.warn(`[nide] 收到未知的窗口动作：${String(action)}`)
    }
  })

  ipcMain.handle(WINDOW_CHANNELS.open, (_event, type: unknown): void => {
    if (typeof type !== 'string' || !isWindowType(type)) {
      console.warn(`[nide] 收到未知的窗口种类：${String(type)}`)
      return
    }
    windowOpeners[type]?.()
  })

  /**
   * 重建主窗口 —— 界面上那个「立即重启」走这条路。
   *
   * 复用切语言的 recreateMainWindow，而不是新写一套：它已经处理好了「先建新窗
   * 再拆旧窗」这个顺序（反过来的话拆窗那一瞬间可能一个窗口都不剩，触发
   * window-all-closed 让应用直接退出），也已经处理了 bounds 与最大化状态的恢复。
   *
   * 不在这里弹确认框：调用方（设置窗口的「是否现在就重启？」）已经把用户的意图
   * 问清楚了。再问一遍是重复确认，只会让人怀疑自己刚才点的是什么。
   */
  ipcMain.handle(WINDOW_CHANNELS.restart, (): void => {
    if (!restartApp) {
      console.warn('[nide] 收到重启请求，但没有人注入重启实现（registerWindowActions）')
      return
    }
    restartApp()
  })
}
