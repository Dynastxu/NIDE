import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { toMonacoLocale } from '@shared/i18n'

const globalEnv = globalThis as unknown as {
  MonacoEnvironment?: { getWorker?: () => Worker }
}

globalEnv.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}

/**
 * Monaco 各语言 NLS 包的显式映射表。
 *
 * 必须是**字面量**的动态 import：Vite 靠静态分析把每个语言切成独立 chunk，
 * 按需加载。写成 ``import(`monaco-editor/nls/lang/${x}.js`)`` 这种拼接，
 * Vite 分析不出来，运行时直接 404。
 *
 * 注意路径写法：monaco-editor 的 exports 映射是 `"./*": "./esm/vs/*.js"`，
 * 所以要写 `monaco-editor/nls/lang/zh-cn.js`，而不是完整的 `esm/vs/...` 路径
 * —— 后者会被重写成 `esm/vs/esm/vs/...` 而解析失败。
 *
 * 这里**没有 'en'**：英文是 Monaco 的内建默认，压根不存在语言文件。
 */
const MONACO_NLS: Record<string, () => Promise<unknown>> = {
  cs: () => import('monaco-editor/nls/lang/cs.js'),
  de: () => import('monaco-editor/nls/lang/de.js'),
  es: () => import('monaco-editor/nls/lang/es.js'),
  fr: () => import('monaco-editor/nls/lang/fr.js'),
  it: () => import('monaco-editor/nls/lang/it.js'),
  ja: () => import('monaco-editor/nls/lang/ja.js'),
  ko: () => import('monaco-editor/nls/lang/ko.js'),
  pl: () => import('monaco-editor/nls/lang/pl.js'),
  'pt-br': () => import('monaco-editor/nls/lang/pt-br.js'),
  ru: () => import('monaco-editor/nls/lang/ru.js'),
  tr: () => import('monaco-editor/nls/lang/tr.js'),
  'zh-cn': () => import('monaco-editor/nls/lang/zh-cn.js'),
  'zh-tw': () => import('monaco-editor/nls/lang/zh-tw.js')
}

let applied = false

/**
 * 把 Monaco 自己的界面文案切成当前语言。
 *
 * 这些文件是**纯副作用模块**：它们只往 `globalThis._VSCODE_NLS_MESSAGES` 和
 * `_VSCODE_NLS_LANGUAGE` 上赋值，Monaco 的 localize() 在调用时才去读这两个全局。
 *
 * 关键约束：必须在 monaco 主模块被**求值之前**完成。Monaco 里有大量在模块作用域
 * 就 registerCommand + localize 的贡献点，等它跑完再改全局就晚了 —— 那些标题会
 * 永远停在英文。所以 main.tsx 里对 App（monaco 在它的依赖链上）用的是动态 import。
 *
 * 还有一点和我们的语言包体系相反：**Monaco 的默认语言是英文**。
 * 所以「英文作为语言包」在 Monaco 这块零成本，反倒是「宿主默认中文」需要额外加载。
 * 语言包也无法给 Monaco 提供翻译，只能声明「去加载 Monaco 自带的哪一份」。
 */
export async function initMonacoNls(): Promise<void> {
  if (applied) return
  applied = true

  const locale = window.__NIDE_BOOT__?.locale
  if (!locale) return

  const target = toMonacoLocale(locale)
  // null = 英文，用 Monaco 内建默认，不需要也不存在语言文件
  if (!target) return

  const load = MONACO_NLS[target]
  if (!load) return

  try {
    await load()
  } catch (err) {
    // Monaco 的文案没切过去不该让整个应用起不来：编辑器本身仍然可用，只是英文
    console.error(`[i18n] Monaco language pack load (${target}) failed`, err)
  }
}
