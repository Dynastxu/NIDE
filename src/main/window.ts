import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { LOCALE_ARG_PREFIX } from '@shared/i18n'
import icon from '../../resources/icon.png?asset'
import { createMainTranslator, getCurrentLocale } from './i18n'

/**
 * 把 locale 塞进渲染进程的启动参数，preload 便能**同步**读到它。
 *
 * 这是全套本地化里唯一必须同步的一环，原因在 Monaco：
 * `globalThis._VSCODE_NLS_MESSAGES` 必须在 monaco 模块被求值**之前**设好，
 * 而 monaco 是被静态 import 进的模块图 —— 那条路径上没有任何 await 的机会。
 * 走 additionalArguments 而不是 ipcRenderer.sendSync，是为了不在渲染进程里
 * 引入一次阻塞式 IPC；代价是切换语言只能靠重建窗口（见 recreateMainWindow）。
 */

const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 800
/** 七分区工作台：左右两列 + 两条按钮条就要吃掉 650px 左右 */
const MIN_WIDTH = 900
const MIN_HEIGHT = 600

let mainWindow: BrowserWindow | null = null

function buildWindow(options: { bounds?: Electron.Rectangle; maximized: boolean }): BrowserWindow {
  const t = createMainTranslator()
  const { bounds, maximized } = options

  const window = new BrowserWindow({
    width: bounds?.width ?? DEFAULT_WIDTH,
    height: bounds?.height ?? DEFAULT_HEIGHT,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    // 页面加载完前先由主进程给出本地化标题；加载后由渲染进程接管 document.title
    title: t('host.app.title'),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      additionalArguments: [`${LOCALE_ARG_PREFIX}${getCurrentLocale()}`]
    }
  })

  window.on('ready-to-show', () => {
    if (maximized) window.maximize()
    window.show()
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  return window
}

export function createMainWindow(): BrowserWindow {
  mainWindow = buildWindow({ maximized: false })
  return mainWindow
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

/**
 * 重建主窗口 —— 切换语言后必须走这条。
 *
 * 为什么不能只 reload：`additionalArguments` 是**建窗时**固定的，reload 不会
 * 重新执行主进程，preload 读到的还是旧 locale。而且 Monaco 的 NLS 全局一旦被
 * 首次求值读过，改它也不会让已经注册好的命令标题变回去。整窗重建是最省心、
 * 也最诚实的做法（VS Code 切语言同样要求重启）。
 *
 * 重建会丢掉渲染进程的未保存状态，所以调用方应当先征求用户同意。
 */
export function recreateMainWindow(): void {
  const previous = mainWindow

  if (!previous || previous.isDestroyed()) {
    createMainWindow()
    return
  }

  const bounds = previous.getBounds()
  const maximized = previous.isMaximized()

  // 先把引用指向新窗口，再销毁旧的，两个理由：
  // - 旧窗口的 closed 回调里有 `mainWindow === window` 判断，此时已不成立，不会清掉新引用；
  // - 顺序反过来的话，拆掉旧窗的那一瞬间可能一个窗口都不剩，触发 window-all-closed，
  //   Linux/Windows 上会让应用直接退出。
  const next = buildWindow({ bounds, maximized })
  mainWindow = next

  // 用 destroy() 而不是 close()：close() 会走完整的关闭流程（包括 beforeunload 之类），
  // 对一个只为了换语言而要丢掉的窗口来说没必要，也更容易带出上面那个退出问题。
  previous.destroy()
}
