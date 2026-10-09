import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { LOCALE_ARG_PREFIX } from '@shared/i18n'
import { LOG_LEVEL_ARG_PREFIX, WINDOW_ARG_PREFIX, type WindowType } from '@shared/window'
import icon from '../../resources/icon.png?asset'
import { createMainTranslator, getCurrentLocale } from './i18n'
import { getLogLevel } from './logger'
import { trackWindowState } from './ipc/window.ipc'

/**
 * 建窗。
 *
 * 宿主**所有**窗口都从这里出去，两个理由：
 *
 * 1) 本地化。locale 靠 `additionalArguments` 同步喂给 preload（为什么必须同步见
 *    下面的注释），而 `additionalArguments` 是**建窗时**固定的 —— 复制一份建窗
 *    代码就等于复制一份本地化接线，漏一处就是那个窗口整体显示中文兜底。
 * 2) 外观一致。无边框、软件渲染开关、外链拦截这些都得一样，否则「设置」窗口
 *    会带着一条原生标题栏出现在自绘标题栏旁边。
 *
 * 每个窗口的差异（种类、标题、尺寸、位置）全部由 WINDOW_SPECS 描述，
 * 这个文件只负责把它翻译成 BrowserWindow 的构造参数。
 */

const DEFAULT_WIDTH = 1280
const DEFAULT_HEIGHT = 800
/** 七分区工作台：左右两列 + 两条按钮条就要吃掉 650px 左右 */
const MIN_WIDTH = 900
const MIN_HEIGHT = 600

/** 「设置」窗口比主窗口小一圈，也更窄——它是附属窗口，不该抢主窗口的戏 */
const SETTINGS_WIDTH = 900
const SETTINGS_HEIGHT = 640
const SETTINGS_MIN_WIDTH = 640
const SETTINGS_MIN_HEIGHT = 460

interface WindowSpec {
  type: WindowType
  /** 窗口标题的**词条 key**。查表时机在建窗时，那时语言已经定了 */
  titleKey: 'host.app.title' | 'host.settings.title'
  width: number
  height: number
  minWidth: number
  minHeight: number
}

const WINDOW_SPECS: Record<WindowType, WindowSpec> = {
  main: {
    type: 'main',
    titleKey: 'host.app.title',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT
  },
  settings: {
    type: 'settings',
    titleKey: 'host.settings.title',
    width: SETTINGS_WIDTH,
    height: SETTINGS_HEIGHT,
    minWidth: SETTINGS_MIN_WIDTH,
    minHeight: SETTINGS_MIN_HEIGHT
  }
}

interface BuildOptions {
  /**
   * 窗口位置与尺寸。
   *
   * 刻意是 Partial：主窗口重建时给的是完整矩形（原地还原）；「设置」窗口只给
   * 一个 parent、位置由居中算出来，尺寸仍用规格里的默认值。缺的字段各自回落。
   */
  bounds?: Partial<Electron.Rectangle>
  maximized?: boolean
  /**
   * 父窗口。
   *
   * 传了它就是一条**生命周期**约束，不只是层级关系：Electron 会在父窗口关闭时
   * 一并关掉子窗口。这正是「主窗口关掉之后，设置窗口不该继续飘在桌面上」要的
   * 效果 —— 而且由系统保证，不用我们自己盯着父窗口的 closed 事件去拆子窗口
   * （那条路上很容易漏掉主窗口被 destroy() 的情形，比如切语言时）。
   */
  parent?: BrowserWindow
}

let mainWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null

/**
 * 自定义标题栏的平台差异。
 *
 * **Windows / Linux**：`frame: false` 整条原生边框都不要，最小化/最大化/关闭
 * 由渲染进程自绘。`thickFrame` 保持默认的 true —— Windows 上它决定无边框窗口
 * 是否保留标准边框样式，关掉就没有投影、没有动画，**也拖不动边框改变尺寸**。
 *
 * **macOS**：不用 `frame: false`，而是 `titleBarStyle: 'hiddenInset'`。这样红黄绿
 * 三个原生按钮还在、位置也符合系统习惯，只是标题栏本身没了。自绘三个按钮会既
 * 和它们重复、又不可能做对（macOS 的全屏按钮语义不是「最大化」）。渲染进程照
 * 这个风格决定要不要画右侧那三个按钮，见 layout/WindowControls.tsx。
 */
function frameOptions(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset' }
  }
  return { frame: false }
}

function buildWindow(type: WindowType, options: BuildOptions = {}): BrowserWindow {
  const spec = WINDOW_SPECS[type]
  const t = createMainTranslator()
  const { bounds, maximized = false, parent } = options

  const window = new BrowserWindow({
    width: bounds?.width ?? spec.width,
    height: bounds?.height ?? spec.height,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    ...(parent ? { parent } : {}),
    minWidth: spec.minWidth,
    minHeight: spec.minHeight,
    show: false,
    // 原生标题栏已经换成自绘的（见 frameOptions），留着菜单栏会在自绘标题栏
    // 上方再压一条，等于白做了。Alt 仍然能唤出菜单。
    autoHideMenuBar: true,
    ...frameOptions(),
    // 页面加载完前先由主进程给出本地化标题。自定义标题栏显示的是渲染进程
    // 传来的文案，这个 title 只剩任务栏 / Alt-Tab / 辅助功能在用。
    title: t(spec.titleKey),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      /**
       * 三个启动参数，都是**建窗时**固定的，reload 不会重新执行主进程：
       * - locale：Monaco 的 NLS 全局必须在 monaco 模块被求值之前设好，那条
       *   路径上没有 await 的机会，所以只能同步喂进来（见 preload 注释）。
       * - window type：渲染进程据此决定挂载哪个界面。
       * - log level：渲染进程据此决定是否接管 console、以及每条日志发不发。
       *   级别由主进程统一解析，两端只共用结论（见 shared/window 的说明）。
       * 这也是「切语言必须重建窗口」的根因。
       */
      additionalArguments: [
        `${LOCALE_ARG_PREFIX}${getCurrentLocale()}`,
        `${WINDOW_ARG_PREFIX}${type}`,
        `${LOG_LEVEL_ARG_PREFIX}${getLogLevel()}`
      ]
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

  trackWindowState(window)

  return window
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function createMainWindow(): BrowserWindow {
  const window = buildWindow('main')
  mainWindow = window
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })
  return window
}

/**
 * 打开「设置」窗口 —— 已经开着就聚焦，不重复开。
 *
 * 两条行为约束：
 *
 * 1. **是开关，不是「每次新建」。** 设置是用户会反复来翻的地方，攒出五个一模
 *    一样的窗口没有任何意义。已经最小化时先还原再聚焦，否则会「打开了但界面上
 *    什么都没发生」。
 * 2. **是主窗口的子窗口。** 主窗口一关它就跟着关（由 parent 关系保证），
 *    并且会一直浮在主窗口之上 —— 这是系统对子窗口的定义，也正是「设置」这种
 *    附属窗口该有的行为：翻设置时不该被主窗口盖住。
 */
export function createSettingsWindow(): BrowserWindow {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  const existing = settingsWindow

  if (existing && !existing.isDestroyed()) {
    /**
     * 父窗口可能已经换过一个实例（切语言会重建主窗口），而 Electron 的父子
     * 关系是**建窗时绑死**的。不重新认父的话，这个子窗口会跟着**旧**主窗口
     * 一起被销毁 —— 用户切一次语言，设置窗口就莫名其妙消失了。
     * 父窗口已经没了时（理论上到不了这儿）传 null 解绑，至少让它活着。
     */
    existing.setParentWindow(parent)
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return existing
  }

  const window = buildWindow('settings', parent ? { parent } : {})

  /**
   * 居中在主窗口上 —— 是**主窗口**的中心，不是屏幕中心。
   *
   * 这里不能用 `window.center()`：那个 API 的语义是 "Moves window to the center
   * of the screen"（Electron 文档原话），多显示器下会跑到主窗口所在那块屏以外，
   * 主窗口偏在屏幕一侧时看着也完全不像附属窗口。
   */
  if (parent) centerOn(window, parent)

  settingsWindow = window
  window.on('closed', () => {
    if (settingsWindow === window) settingsWindow = null
  })

  return window
}

/**
 * 把一个已建好的窗口居中到参照窗口上。
 *
 * 必须在建窗**之后**调用：BrowserWindow 的构造参数里没有「居中」这一项，
 * 而且此刻才拿得到最终尺寸（含边框与缩放比例）。
 *
 * 两条防御，都不是洁癖：
 *
 * 1. **夹进工作区。** 直接算 `父窗口中心 - 自身尺寸/2` 会漏掉一种常见情形 ——
 *    主窗口贴在屏幕下边缘时（高度 800 的窗口摆在 1080 的屏上），居中会把子窗口
 *    顶出去一截，正好复现「启动位置超出屏幕」。用主窗口可见部分与工作区的
 *    交集来居中，主窗口越界时结果自动跟着收敛。用工作区而不是整屏，是为了
 *    避开任务栏。
 * 2. **居中不了就不动。** 交集算出来是空的（主窗口整个在屏幕外，比如刚从
 *    一块被拔掉的显示器上恢复）时保持原样，总比摆到一个荒唐的位置强。
 */
function centerOn(window: BrowserWindow, reference: BrowserWindow): void {
  const area = reference.getBounds()
  const work = screen.getDisplayMatching(area).workArea

  const left = Math.max(area.x, work.x)
  const top = Math.max(area.y, work.y)
  const right = Math.min(area.x + area.width, work.x + work.width)
  const bottom = Math.min(area.y + area.height, work.y + work.height)

  if (right <= left || bottom <= top) return

  const [width, height] = window.getSize()
  window.setPosition(
    Math.round((left + right) / 2 - width / 2),
    Math.round((top + bottom) / 2 - height / 2)
  )
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
 *
 * 设置窗口会跟着一起消失（它是旧主窗口的子窗口）。这是**刻意的**：它的界面文案
 * 是切换前的语言，留着就会「主窗口是英文、设置窗口还是中文」。代价是切语言时
 * 设置窗口被关掉，这比半新半旧好。
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
  //   Linux/Windows 上会让应用直接退出。设置窗口此刻还开着也救不了场 ——
  //   它是旧主窗口的子窗口，会跟着一起被拆掉，不能把「应用别退出」押在它上面。
  const next = buildWindow('main', { bounds, maximized })
  mainWindow = next
  next.on('closed', () => {
    if (mainWindow === next) mainWindow = null
  })

  // 用 destroy() 而不是 close()：close() 会走完整的关闭流程（包括 beforeunload 之类），
  // 对一个只为了换语言而要丢掉的窗口来说没必要，也更容易带出上面那个退出问题。
  previous.destroy()
}
