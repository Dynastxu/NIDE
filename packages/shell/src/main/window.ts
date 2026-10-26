import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { LOCALE_ARG_PREFIX } from '@nide/contracts/i18n'
import {
  APPEARANCE_ARG_PREFIX,
  THEME_PALETTE_ARG_PREFIX,
  encodeAppearancePreference
} from '@nide/contracts/appearance'
import { PROJECT_ARG_PREFIX } from '@nide/contracts/project'
import type { ProjectRecord } from '@nide/contracts/project'
import {
  LOG_LEVEL_ARG_PREFIX,
  WINDOW_ARG_PREFIX,
  systemWindowTitle,
  type WindowType
} from '@nide/contracts/window'
import icon from '../../resources/icon.png?asset'
import { createMainTranslator, getCurrentLocale } from './i18n'
import { getAppearancePreference, getCurrentPalette, getCurrentWindowColor } from './appearance'
import { getLogLevel, loggerFor } from './logger'
import { startupProject } from './host/project'
import { trackWindowState } from './ipc/window.ipc'
import { gateWindowClose } from './lifecycle'

const logger = loggerFor('window')

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

/**
 * 「欢迎」窗口：没有项目可开时的入口。
 *
 * 比设置窗口略宽 —— 它右边要放项目列表（一行里名字和路径并排），窄了会被压成
 * 两行；高度和设置窗口齐平，两个窗口互相切换时视觉上不跳。
 */
const WELCOME_WIDTH = 960
const WELCOME_HEIGHT = 640
const WELCOME_MIN_WIDTH = 720
const WELCOME_MIN_HEIGHT = 480

interface WindowSpec {
  type: WindowType
  width: number
  height: number
  minWidth: number
  minHeight: number
}

/**
 * 各窗口的尺寸规格。标题不在这里 —— 标题由 `windowTitle()` 统一算（窗口种类 +
 * 当前项目名），放在规格表里就没有地方安放「项目名」这一截了。
 */
const WINDOW_SPECS: Record<WindowType, WindowSpec> = {
  main: {
    type: 'main',
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT
  },
  welcome: {
    type: 'welcome',
    width: WELCOME_WIDTH,
    height: WELCOME_HEIGHT,
    minWidth: WELCOME_MIN_WIDTH,
    minHeight: WELCOME_MIN_HEIGHT
  },
  settings: {
    type: 'settings',
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
   * 一并关掉子窗口。这正是「根窗口关掉之后，设置窗口不该继续飘在桌面上」要的
   * 效果 —— 而且由系统保证，不用我们自己盯着父窗口的 closed 事件去拆子窗口
   * （那条路上很容易漏掉根窗口被 destroy() 的情形，比如切语言时）。
   */
  parent?: BrowserWindow
}

let mainWindow: BrowserWindow | null = null
let welcomeWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null

/**
 * 主窗口**绑定的**项目路径。
 *
 * 这不是第二份「打开过的项目」：`projects.json` 的唯一实现在 host，这里只记「这个
 * 窗口是在哪个项目上建出来的」。项目路径经 `additionalArguments` 在建窗时固定，
 * reload 改不动它 —— 所以重建窗口（切语言、点重启）时必须原样再用一次，而那时没有
 * 机会再问一次 host（重建是同步的）。
 *
 * 写入点只有两处，都带着 host 给的记录：启动时的 `openStartupWindow()`、打开 / 换
 * 项目时的 `activateMainWindow()`。清空发生在「主窗口没了」的那两个时刻：回到欢迎
 * 窗口（关闭项目）与主窗口被关掉。它因此**不会**比 host 多知道什么，只可能短暂
 * 落后 —— 新窗口的 preload 一挂上就会用这个路径调 `project.setCurrent`，两边随即对齐。
 */
let boundProjectPath: string | null = null

/** 主窗口当前绑定的项目路径；停在欢迎窗口时为 null。给换项目的二次确认用 */
export function getBoundProjectPath(): string | null {
  return boundProjectPath
}

/**
 * 登记一个根窗口（主窗口 / 欢迎窗口）。
 *
 * 两个根窗口是**互斥**的：有项目就进主窗口，没有就进欢迎窗口。把「赋值 + 在关闭
 * 时清引用」收成一处，是因为下面有三条路径都会造它们（启动、打开项目、
 * 重建窗口），散着写迟早会漏掉某一个清引用的回调，留下一个指向已销毁窗口的悬空值。
 */
function trackRoot(type: 'main' | 'welcome', window: BrowserWindow): void {
  if (type === 'main') {
    mainWindow = window
    window.on('closed', () => {
      if (mainWindow !== window) return
      mainWindow = null
      /**
       * 主窗口没了，「当前项目」也就不在了。
       *
       * 不清的话，用户关掉主窗口、回到欢迎窗口之后从列表里打开同一批项目时，会被
       * 问一句「要切换项目吗」—— 而那个会丢东西的窗口刚刚已经被关掉了。
       * 重建窗口那条路不受影响：新窗口先登记，旧窗口的 closed 回调此时已经对不上
       * `mainWindow`，不会把新值清掉。
       */
      boundProjectPath = null
    })
    return
  }

  welcomeWindow = window
  window.on('closed', () => {
    if (welcomeWindow === window) welcomeWindow = null
  })
}

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
  // 只有主窗口认项目；欢迎 / 设置窗口不该因为「上一个项目还在」而带上项目标题
  const projectPath = type === 'main' ? boundProjectPath : null

  const window = new BrowserWindow({
    width: bounds?.width ?? spec.width,
    height: bounds?.height ?? spec.height,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    ...(parent ? { parent } : {}),
    minWidth: spec.minWidth,
    minHeight: spec.minHeight,
    show: false,
    /**
     * 窗口底色。
     *
     * 取自当前配色（见 shared/theme 的 THEME_WINDOW_COLORS），值与样式表里那种配色的
     * 页面底色一致。首帧本身由 `ready-to-show` 兜住了（页面画完才 show），它管的是
     * **页面之外与页面重绘之前**露出来的地方：拖动改大窗口时新露出的那块、合成器还没
     * 跟上时的窗口背景。
     */
    backgroundColor: getCurrentWindowColor(),
    // 原生标题栏已经换成自绘的（见 frameOptions），留着菜单栏会在自绘标题栏
    // 上方再压一条，等于白做了。Alt 仍然能唤出菜单。
    autoHideMenuBar: true,
    ...frameOptions(),
    // 页面加载完前先由主进程给出本地化标题。自定义标题栏显示的是渲染进程
    // 传来的文案，这个 title 只剩任务栏 / Alt-Tab / 辅助功能在用 —— 所以这里用
    // 带项目名的那一版：那块地方只有一行字符串可看，项目名是唯一的区分手段。
    title: systemWindowTitle(t, type, projectPath),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      /**
       * 七个启动参数，都是**建窗时**固定的，reload 不会重新执行主进程：
       * - locale：Monaco 的 NLS 全局必须在 monaco 模块被求值之前设好，那条
       *   路径上没有 await 的机会，所以只能同步喂进来（见 preload 注释）。
       * - appearance：完整偏好（选了哪套主题、要不要跟随系统）。**必须同步**：
       *   主进程的广播只到得了建窗时已经存在的窗口。
       * - theme palette：当前配色是深是浅。渲染进程要在首帧之前据此决定根元素挂不挂
       *   `.theme-light`，晚一步就会先按深色画一帧。
       * - window type：渲染进程据此决定挂载哪个界面。
       * - log level：渲染进程据此决定是否接管 console、以及每条日志发不发。
       *   级别由主进程统一解析，两端只共用结论（见 shared/window 的说明）。
       * - project：当前项目路径（没有项目时是空串）。标题栏第一帧就要显示项目名，
       *   异步 IPC 会先渲染一版没有项目名的标题再跳一下。
       *
       * 这也是「切语言必须重建窗口」的根因。主题**不受**这条约束：它不重建窗口，
       * 各窗口收到 host:appearance-changed 广播后自己换掉即可（见 main/appearance）。
       */
      additionalArguments: [
        `${LOCALE_ARG_PREFIX}${getCurrentLocale()}`,
        `${APPEARANCE_ARG_PREFIX}${encodeAppearancePreference(getAppearancePreference())}`,
        `${THEME_PALETTE_ARG_PREFIX}${getCurrentPalette()}`,
        `${WINDOW_ARG_PREFIX}${type}`,
        `${LOG_LEVEL_ARG_PREFIX}${getLogLevel()}`,
        `${PROJECT_ARG_PREFIX}${projectPath ?? ''}`
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

  /**
   * 关窗的二次确认。挂在**建窗**这一处，而不是挂在自绘的那颗 ✕ 上：✕、Alt+F4、
   * 任务栏的「关闭窗口」最后都走窗口的 `close` 事件，挂在入口那一侧就总有一条路
   * 漏在外面（见 lifecycle.ts）。
   *
   * 子窗口不问：设置窗口关掉不损失任何东西。
   */
  gateWindowClose(window, type !== 'settings')

  return window
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function getWelcomeWindow(): BrowserWindow | null {
  return welcomeWindow
}

/**
 * 打开主窗口 —— **必须**带着 host 给的记录进来。
 *
 * 项目路径要同时写进窗口标题与 `additionalArguments`，两者都是建窗时固定的，所以
 * 「打开哪个项目」不能等窗口起来之后再问。
 *
 * 谁调它、什么时候调，见 `openStartupWindow()` 与 `src/main/ipc/project.ipc.ts`。
 */
export function createMainWindow(project: ProjectRecord): BrowserWindow {
  boundProjectPath = project.path

  const window = buildWindow('main')
  trackRoot('main', window)
  return window
}

/** 打开欢迎窗口：没有可用的「上次打开的项目」时的入口 */
export function createWelcomeWindow(): BrowserWindow {
  const window = buildWindow('welcome')
  trackRoot('welcome', window)
  return window
}

/**
 * 启动时该打开哪个项目：问 host。
 *
 * host 是 `projects.json` 的唯一实现，也是「那条记录的目录还在不在」的判断方，
 * 所以这里没有本地判断可做。host 起不来时给 null（回落欢迎窗口），并且把原因记进
 * 日志 —— 那种情况下窗口本身还开得出来，只是没有任何项目可读。
 */
async function startupProjectOrNull(): Promise<ProjectRecord | null> {
  try {
    return await startupProject()
  } catch (error) {
    logger.error('Failed to resolve the startup project through host', { error })
    return null
  }
}

/**
 * 启动 / 重新激活时开哪个根窗口 —— 宿主只在这一个地方做这个决定。
 *
 * 「默认打开上次打开的文件夹」落在 host：`projects.json` 的唯一实现在那边，它也
 * 判断「那条记录的目录还在不在」。所以这一步是**异步**的，窗口要等 host ready 之后
 * 才建得出来 —— 换来的是 shell 不再读第二份 `projects.json`。
 *
 * host 起不来时回落成欢迎窗口：那种情况下任何项目都读不了（文件 / 配置全在 host），
 * 给一个能重新选目录的入口，比开一个打不开任何文件的主窗口有用。
 */
export async function openStartupWindow(): Promise<BrowserWindow> {
  const project = await startupProjectOrNull()
  return project ? createMainWindow(project) : createWelcomeWindow()
}

/**
 * 切到主窗口 —— 项目记录由调用方从 host 拿到（启动时是 openStartupWindow，其余时候
 * 是打开 / 切换项目的结果）。
 *
 * 两条路径：
 * - 主窗口还没开（从欢迎窗口打开项目）：建主窗口，再拆欢迎窗口；
 * - 主窗口已经开着（标题栏的项目下拉换项目）：**原地重建**它 —— 项目路径是经
 *   `additionalArguments` 在建窗时固定下来的，换项目必须换一个窗口，reload 改不动它。
 *
 * 顺序约束与 `recreateRootWindow()` 相同：**先建新窗、再拆旧窗**，否则拆的那一
 * 瞬间可能一个窗口都不剩，触发 window-all-closed 让应用直接退出。
 */
export function activateMainWindow(project: ProjectRecord): void {
  boundProjectPath = project.path

  if (mainWindow && !mainWindow.isDestroyed()) {
    recreateRootWindow()
    return
  }

  createMainWindow(project)
  destroyWelcomeWindow()
}

/**
 * 关掉当前项目：回退到欢迎窗口。
 *
 * 只换窗口，**不动**「打开过的项目」那份记录 —— 它还留在列表里，也仍然是下次启动
 * 时要打开的那个（见 shared/project）。「关闭项目」是这一次会话的事，不是把记录删掉。
 *
 * 绑定的项目路径在这里清掉：欢迎窗口没有项目，之后重建任何窗口都不该再带上它。
 */
export function returnToWelcomeWindow(): void {
  boundProjectPath = null
  createWelcomeWindow()

  const window = mainWindow
  if (window && !window.isDestroyed()) window.destroy()
}

/**
 * 拆掉欢迎窗口（打开项目之后）。
 *
 * 顺序约束和 `recreateRootWindow()` 一样：**先建新窗、再拆旧窗**。反过来的话
 * 拆的那一瞬间可能一个窗口都不剩，触发 window-all-closed 让应用直接退出。
 * 调用方（project.ipc.ts）负责先建主窗口。
 *
 * 副作用是挂在欢迎窗口下面的设置窗口会一并消失 —— 它是欢迎窗口的子窗口。
 * 这和「切语言时设置窗口跟着主窗口消失」是同一条既定语义，不是新问题。
 */
export function destroyWelcomeWindow(): void {
  const window = welcomeWindow
  if (window && !window.isDestroyed()) window.destroy()
}

/**
 * 打开「设置」窗口 —— 已经开着就聚焦，不重复开。
 *
 * 两条行为约束：
 *
 * 1. **是开关，不是「每次新建」。** 设置是用户会反复来翻的地方，攒出五个一模
 *    一样的窗口没有任何意义。已经最小化时先还原再聚焦，否则会「打开了但界面上
 *    什么都没发生」。
 * 2. **是根窗口的子窗口。** 根窗口（主窗口；没有项目时是欢迎窗口）一关它就跟着关
 *    （由 parent 关系保证），并且会一直浮在它之上 —— 这是系统对子窗口的定义，
 *    也正是「设置」这种附属窗口该有的行为：翻设置时不该被根窗口盖住。
 */
export function createSettingsWindow(): BrowserWindow {
  const root = mainWindow ?? welcomeWindow
  const parent = root && !root.isDestroyed() ? root : null
  const existing = settingsWindow

  if (existing && !existing.isDestroyed()) {
    /**
     * 父窗口可能已经换过一个实例（切语言会重建根窗口），而 Electron 的父子
     * 关系是**建窗时绑死**的。不重新认父的话，这个子窗口会跟着**旧**根窗口
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
 * 重建**根窗口**（主窗口；没有项目时是欢迎窗口）—— 切换语言后必须走这条。
 *
 * 为什么不能只 reload：`additionalArguments` 是**建窗时**固定的，reload 不会
 * 重新执行主进程，preload 读到的还是旧 locale。而且 Monaco 的 NLS 全局一旦被
 * 首次求值读过，改它也不会让已经注册好的命令标题变回去。整窗重建是最省心、
 * 也最诚实的做法（VS Code 切语言同样要求重启）。
 *
 * 重建的是「当前那个根窗口」而不是写死主窗口：会话可能停在欢迎窗口上（用户还没
 * 选项目就进了设置 -> 语言），那时凭空造一个主窗口等于绕过「没有项目就先选项目」
 * 这条规则，还会显示一个没有项目的空工作台。种类按当前有哪个根窗口决定。
 *
 * 重建会丢掉渲染进程的未保存状态，所以调用方应当先征求用户同意。
 *
 * 主窗口的项目路径取自 `boundProjectPath`（这个窗口建出来时用的那个）—— 重建是同步
 * 的，没有机会再问一次 host。换项目走 `activateMainWindow()`，它先把新路径写进去
 * 再重建，所以这里拿到的永远是这个窗口该有的那个项目。
 *
 * 设置窗口会跟着一起消失（它是旧根窗口的子窗口）。这是**刻意的**：它的界面文案
 * 是切换前的语言，留着就会「主窗口是英文、设置窗口还是中文」。代价是切语言时
 * 设置窗口被关掉，这比半新半旧好。
 */
export function recreateRootWindow(): void {
  const previous = mainWindow ?? welcomeWindow
  const type: 'main' | 'welcome' = mainWindow ? 'main' : 'welcome'

  if (!previous || previous.isDestroyed()) {
    void openStartupWindow()
    return
  }

  const bounds = previous.getBounds()
  const maximized = previous.isMaximized()

  // 先把引用指向新窗口，再销毁旧的，两个理由：
  // - 旧窗口的 closed 回调里有 `xxxWindow === window` 判断，此时已不成立，不会清掉新引用；
  // - 顺序反过来的话，拆掉旧窗的那一瞬间可能一个窗口都不剩，触发 window-all-closed，
  //   Linux/Windows 上会让应用直接退出。设置窗口此刻还开着也救不了场 ——
  //   它是旧根窗口的子窗口，会跟着一起被拆掉，不能把「应用别退出」押在它上面。
  const next = buildWindow(type, { bounds, maximized })
  trackRoot(type, next)

  // 用 destroy() 而不是 close()：close() 会走完整的关闭流程（包括 beforeunload 之类），
  // 对一个只为了换语言而要丢掉的窗口来说没必要，也更容易带出上面那个退出问题。
  previous.destroy()
}
