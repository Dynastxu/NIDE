import * as monaco from 'monaco-editor'
import { getPalette, onPaletteChange } from '@renderer/appearance/palette'
import { loggerFor } from '@renderer/logger'
import type { ThemePalette } from '@shared/theme'

const logger = loggerFor('editor')

/**
 * 把宿主的深浅配色翻译成 Monaco 的主题名。
 *
 * 现在用的是 Monaco 自带的两套：
 * - 深色 `vs-dark` —— 与宿主原来的深色界面是一路（编辑器本来就是深色的）；
 * - 浅色 `vs` —— Monaco 的默认浅色。
 *
 * 想更贴合宿主自己的色板时，下一步是 `monaco.editor.defineTheme('nide-light', …)`
 * 用 light.css 里那几个值定义一套，再把这里换成 `'nide-light'`。那是**纯增量**的
 * 改动：本文件的接口不用动，只是多一个 defineTheme 调用。
 */
const MONACO_THEME: Record<ThemePalette, string> = {
  dark: 'vs-dark',
  light: 'vs'
}

let subscribed = false

/**
 * 让 Monaco 的配色跟着宿主主题走。
 *
 * **必须尽早调用**（main.tsx 的启动序列里）：Monaco 的主题是**实例级全局**，所以
 * 先把当前值同步一次，编辑器创建时就不会先按默认的 `vs` 画一帧深色界面才跳。
 *
 * 与语言（NLS）的区别值得记一笔：语言必须**在 monaco 模块求值之前**通过全局变量
 * 设好，跑完就改不动了；主题随时可以改，`setTheme` 会立刻让所有已打开的编辑器重绘
 * —— 所以主题**不需要**重建窗口，这也是它能走草稿、「取消」还能退回去的原因。
 */
export function initMonacoTheme(): void {
  if (subscribed) return
  subscribed = true

  // 先同步一次当前值：编辑器创建时读的就是它
  monaco.editor.setTheme(MONACO_THEME[getPalette()])

  onPaletteChange((palette) => {
    try {
      monaco.editor.setTheme(MONACO_THEME[palette])
    } catch (err) {
      // 主题没切过去不该让编辑器不可用：它仍然能编辑，只是配色与界面不一致
      logger.error('Failed to switch the Monaco theme', { palette, error: err })
    }
  })
}
