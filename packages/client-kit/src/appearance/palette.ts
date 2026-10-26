import type { ThemePalette } from '@nide/contracts/theme'

/**
 * 当前配色的**最小**状态：它只有一个值，加一组订阅者。
 *
 * 为什么不放在 zustand 的 appearance store 里：这个值要被 **Monaco** 消费
 * （`monaco.editor.setTheme`），而 Monaco 是个很大的模块。设置窗口不挂编辑器，
 * 它只需要"现在是不是浅色"这一个布尔量 —— 如果它为了读这个值去 import store，
 * 而 store 又牵着 Monaco，设置窗口就会平白加载整个编辑器。
 *
 * 所以这里切一刀：
 * - 本模块：值 + 订阅，**不 import 任何重东西**（设置窗口、欢迎窗口都能用）；
 * - `stores/appearance.store.ts`：从主进程拿偏好与列表，然后调 `applyPalette`；
 * - `editor/monaco-theme.ts`：订阅本模块，把值翻译成 Monaco 的主题名（只有编辑器那条链）。
 */

let current: ThemePalette = 'dark'

const listeners = new Set<(palette: ThemePalette) => void>()

export function getPalette(): ThemePalette {
  return current
}

/**
 * 订阅配色变化。返回退订函数。
 *
 * 订阅者立刻拿到的**不是**当前值 —— 想同步一次就自己调 `getPalette()`。
 * 刻意不在这里做"订阅时先回调一次"：那会让"应用配色"和"通知订阅者"两件事
 * 在同一个调用栈里发生，而 Monaco 的主题是全局状态，先后顺序反了就会出现
 * "订阅者先按旧主题画一次"的闪烁。
 */
export function onPaletteChange(listener: (palette: ThemePalette) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 应用一套配色：给根元素挂 / 摘 `.theme-light`，并通知订阅者。
 *
 * **深色时刻意什么都不挂**：组件里的色阶就是深色，`index.css` 的 body 也是深色。
 * 于是"深色主题"这条路径上没有任何一层可以被写错。
 *
 * `color-scheme` 由 light.css 里的 `.theme-light` 规则声明（滚动条、原生 `<select>`
 * 的下拉列表、表单控件都由 Chromium 按它来画）。
 */
export function applyPalette(palette: ThemePalette): void {
  const changed = current !== palette
  current = palette

  document.documentElement.classList.toggle('theme-light', palette === 'light')

  // 没变就不通知：订阅者（Monaco 的 setTheme）做的是全局副作用，能省则省
  if (!changed) return
  for (const listener of listeners) listener(palette)
}
