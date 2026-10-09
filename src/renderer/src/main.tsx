import React from 'react'
import ReactDOM from 'react-dom/client'
import { initMonacoNls } from './monaco-env'
import { installRendererLogger, loggerFor } from './logger'
import './assets/index.css'
import type { JSX } from 'react'
import type { WindowType } from '@shared/window'

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
 * 4) 最后才把界面拉进来，monaco 从这一刻开始求值。
 *
 * 任何一步失败都不该白屏：initMonacoNls 内部吞掉异常（编辑器退化成英文），
 * i18n store 的 load 失败时会保留中文基础表。
 */
installRendererLogger()

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
   * 窗口种类在**启动参数**里，所以这一步在首帧之前就能确定，不需要先渲染
   * 一个默认界面再异步换成另一个。
   */
  const { windowType } = window.__NIDE_BOOT__
  document.title = getT()(windowType === 'settings' ? 'host.settings.title' : 'host.app.title')

  const { default: Root } = await ROOTS[windowType]()

  logger.info('Renderer boot completed', { windowType, locale })

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>
  )
}

void boot()
