import React from 'react'
import ReactDOM from 'react-dom/client'
import { initMonacoNls } from './monaco-env'
import './assets/index.css'

/**
 * 启动序列。四步的顺序**都有理由，不能调换**：
 *
 * 1) Monaco 的 NLS 全局必须在 monaco 模块被求值之前设好。所以这里用动态
 *    import 把 App（monaco 在它的依赖链上）推迟到设完之后 —— 静态 import
 *    的求值顺序由模块图决定，插不进这个 await。
 * 2) 词条表要在首帧之前就位，否则会先渲染一遍中文再跳成目标语言。
 *    t() 因此从第一次渲染起就是对的，组件里不需要任何 loading 分支。
 * 3) lang 属性影响断行、字体回退和屏幕阅读器，title 是原生标题栏的文字 ——
 *    两者都跟着语言走，而 index.html 里写死的是中文。
 * 4) 最后才把 App 拉进来，monaco 从这一刻开始求值。
 *
 * 任何一步失败都不该白屏：initMonacoNls 内部吞掉异常（编辑器退化成英文），
 * i18n store 的 load 失败时会保留中文基础表。
 */
async function boot(): Promise<void> {
  await initMonacoNls()

  const { useI18nStore, getT } = await import('./stores/i18n.store')
  await useI18nStore.getState().load()

  const { locale } = useI18nStore.getState()
  document.documentElement.lang = locale
  document.title = getT()('host.app.title')

  const { default: App } = await import('./App')

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void boot()
