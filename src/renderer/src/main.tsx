import React from 'react'
import ReactDOM from 'react-dom/client'
import { initMonacoNls } from './monaco-env'
import { installRendererLogger, loggerFor } from './logger'
import './assets/index.css'
import type { JSX } from 'react'
import { systemWindowTitle, type WindowType } from '@shared/window'
import { ConfirmHost } from './ui/ConfirmHost'
import type { ProjectListItem } from '@shared/project'
import type { ClientRuntime } from '@nide/client-runtime'

/**
 * 启动序列。顺序**都有理由，不能调换**：
 *
 * 0) 日志先接管 console：它要盖住的是后面每一步的输出，晚一步接管，最需要
 *    日志的「启动失败」阶段反而是空白。
 * 1) Monaco 的 NLS 全局必须在 monaco 模块被求值之前设好。所以这里用动态
 *    import 把界面（monaco 在它的依赖链上）推迟到设完之后 —— 静态 import
 *    的求值顺序由模块图决定，插不进这个 await。
 * 2) 词条表要在首帧之前就位，否则会先渲染一遍中文再跳成目标语言。
 *    t() 因此从第一次渲染起就是对的，组件里不需要任何 loading 分支。
 * 3) lang 属性影响断行、字体回退和屏幕阅读器，title 是任务栏 / Alt-Tab 上的
 *    文字 —— 两者都跟着语言走，而 index.html 里写死的是中文。
 * 4) 主题要在**首帧之前**挂到根元素上：晚一步就会先画一帧错误颜色（浅色主题下
 *    表现为整屏闪一下深色）。启动参数里带着主进程已解析的主题，所以这里同步可得。
 * 5) 最后才把界面拉进来，monaco 从这一刻开始求值。
 *
 * 任何一步失败都不该白屏：initMonacoNls 内部吞掉异常（编辑器退化成英文），
 * i18n store 的 load 失败时会保留中文基础表。
 */
installRendererLogger()

// 插件 IIFE bundle 通过全局拿 React / ReactDOM；必须在任何 bundle 注入之前挂好。
;(window as unknown as { React?: typeof React }).React = React
;(window as unknown as { ReactDOM?: typeof ReactDOM }).ReactDOM = ReactDOM

const logger = loggerFor('renderer')

/**
 * 每一种窗口挂载哪个根组件。
 *
 * 统一用动态 import，哪怕主窗口每次都必然要加载：静态 import 会让**所有**窗口
 * 都吃下整张模块图（设置窗口平白加载 Monaco），而且以后加一个「关于」这类
 * 轻量窗口时，必然要改回动态 —— 不如现在就只有一种写法，加窗口时不必判断。
 *
 * 注意：加窗口种类时这里要补一条，而**不是**在下面 boot() 里加 if。
 */
const ROOTS: Record<WindowType, () => Promise<{ default: () => JSX.Element }>> = {
  main: () => import('./App'),
  welcome: () => import('./welcome/WelcomeApp'),
  settings: () => import('./settings/SettingsApp').then((m) => ({ default: m.SettingsApp }))
}

async function boot(): Promise<void> {
  await initMonacoNls()

  const { useI18nStore, getT } = await import('./stores/i18n.store')
  await useI18nStore.getState().load()

  const { locale } = useI18nStore.getState()
  document.documentElement.lang = locale

  /**
   * 窗口标题。
   *
   * 标题栏是自绘的，显示的是组件树里的文案；这里设的 title 服务于任务栏、
   * Alt-Tab 和辅助功能 —— 对无边框窗口尤其不能省，否则它们在系统里全叫
   * "Electron"。
   *
   * 窗口种类与项目路径都在**启动参数**里，所以这一步在首帧之前就能确定，
   * 不需要先渲染一个默认界面再异步换成另一个。这里用**带项目名**的那一版：它设的
   * 是操作系统那一层的标题（任务栏 / Alt-Tab），而主窗口自绘的标题栏只显示应用名 ——
   * 项目名在标题栏里由项目下拉承担（见 shared/window 的两个标题函数）。
   */
  const { windowType, projectPath } = window.__NIDE_BOOT__
  document.title = systemWindowTitle(getT(), windowType, projectPath)

  /**
   * 主题接线。放在这里而不是某个组件里：它要挂根元素的类、要订阅主进程广播，
   * 两件事都与"哪个界面"无关（主窗口、欢迎窗口、设置窗口一模一样）。
   *
   * 界面拉进来之前完成，保证首帧颜色就是对的。
   */
  const { initAppearance } = await import('./stores/appearance.store')
  initAppearance()

  /**
   * Monaco 的配色也要跟着主题走。
   *
   * 只在**主窗口**做：只有它会挂编辑器（设置窗口、欢迎窗口没有），而这一步会
   * import monaco —— 一个很大的模块，不该为"用不到它"的窗口付这份代价。
   *
   * 放在界面拉进来之前：Monaco 的主题是实例级全局，先同步一次，编辑器创建时就不会
   * 先按默认浅色画一帧再跳。
   */
  if (windowType === 'main') {
    const { initMonacoTheme } = await import('./editor/monaco-theme')
    initMonacoTheme()
  }

  /**
   * 根组件。
   *
   * main / welcome 走 slot：对应 root 插件由客户端 Cordis 树注册，渲染的还是
   * 现有 `App` / `WelcomeApp`（组件一行没改）。settings 仍走旧路径。
   */
  let Root: () => JSX.Element
  const slotName =
    windowType === 'main'
      ? 'main.root'
      : windowType === 'welcome'
        ? 'welcome.root'
        : 'settings.root'

  if (slotName) {
    const slot = slotName
    const runtime = await loadClientRuntime()
    if (runtime) {
      const { Slot, SlotProvider } = await import('@nide/client-ui-renderer')
      logger.info('Window slot ready', { slot, occupants: runtime.slots.count(slot) })
      Root = () => (
        <SlotProvider registry={runtime.slots}>
          <Slot name={slot} />
        </SlotProvider>
      )
    } else {
      Root = (await ROOTS[windowType]()).default
    }
  } else {
    Root = (await ROOTS[windowType]()).default
  }

  logger.info('Renderer boot completed', { windowType, locale })

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      {/*
        行为级二次确认的落点包在**每一种**窗口外面（见 ui/ConfirmHost）：确认问在
        哪一个窗口上取决于谁发起了那个动作，所以每一扇窗都要有地方接住它。

        它是**静态** import，与上面 ROOTS「一律动态」那条约定不冲突：它的依赖图里
        只有 React 与那个浮层组件（没有 Monaco），不值得为它再绕一层动态 import。
      */}
      <ConfirmHost>
        <Root />
      </ConfirmHost>
    </React.StrictMode>
  )
}

/**
 * 启动客户端 Cordis 树（MVP），并缓存同一个 Promise。
 *
 * 欢迎窗口要等它注册好 `welcome.root` 才能渲染；主窗口只是并行启动，不阻塞。
 */
let clientRuntimePromise: Promise<ClientRuntime | null> | null = null

function loadClientRuntime(): Promise<ClientRuntime | null> {
  if (!clientRuntimePromise) {
    clientRuntimePromise = import('@nide/client-runtime')
      .then(({ createClientRuntime }) =>
        createClientRuntime({ windowType: window.__NIDE_BOOT__.windowType })
      )
      .then((runtime) => {
        ;(window as unknown as { __NIDE_CLIENT__?: unknown }).__NIDE_CLIENT__ = runtime
        logger.info('Client Cordis runtime ready')
        return runtime
      })
      .catch((error: unknown) => {
        logger.warn('Client Cordis runtime failed', { error })
        return null
      })
  }
  return clientRuntimePromise
}

function bootClientRuntime(): void {
  void loadClientRuntime()
}

/**
 * 临时诊断：确认 renderer -> host 的通用 RPC 通了，并对照旧 IPC 的结果。
 *
 * 主进程在 `did-finish-load` 后才送 port，而 boot() 可能先跑完，所以这里
 * 最多等 2 秒。阶段 2 接入真正的业务 namespace 后删除。
 */
async function probeHost(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (window.nideHost?.available()) {
      try {
        const [hostProjects, legacyProjects] = await Promise.all([
          window.nideHost.invoke<ProjectListItem[]>('project', 'list'),
          window.hostAPI.projects.list()
        ])
        logger.info('Host project.list ok', {
          host: hostProjects.length,
          legacy: legacyProjects.length,
          same: JSON.stringify(hostProjects) === JSON.stringify(legacyProjects)
        })

        const root = window.__NIDE_BOOT__.projectPath
        if (root) {
          const dir = await window.hostAPI.projects.readDir(root)
          logger.info('Host files.readDir ok', {
            ok: dir.ok,
            entries: dir.ok ? dir.entries.length : 0,
            ...(dir.ok ? {} : { reason: dir.reason })
          })
        }
      } catch (error) {
        logger.warn('Host project.list failed', { error })
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  logger.warn('Host port was not attached')
}

if (window.__NIDE_BOOT__.windowType === 'main') {
  void probeHost()
}

void bootClientRuntime()
void boot()
