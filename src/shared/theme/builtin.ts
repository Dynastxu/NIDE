import type { ThemeDescriptor, ThemeId, ThemePalette } from './types.js'

/**
 * 宿主内置的两套主题 —— **纯数据、无运行时 import**。
 *
 * 这一点是刻意的：host（纯 Node ESM）要读它来判断「这个主题 id 存在吗 / 它是深是浅」，
 * 而 host 加载不了任何带运行时 import 的共享文件。所以类型用 `./types.js`（纯类型，
 * 运行时会被擦除）引进来。
 *
 * 配色不在数据里 —— 它在样式表中：
 * - 深色：组件里的原始色阶（`bg-zinc-900` …）+ `assets/index.css`；
 * - 浅色：`assets/light.css` 对前者的逐条翻译。
 *
 * 这里只声明"有哪两套、各自深浅、窗口底色是什么"。
 */

export const BUILTIN_DARK_THEME: ThemeId = 'builtin.dark'
export const BUILTIN_LIGHT_THEME: ThemeId = 'builtin.light'

/** 没有偏好、或偏好指向的主题不存在时用它 */
export const DEFAULT_THEME: ThemeId = BUILTIN_DARK_THEME

export const BUILTIN_THEMES: readonly ThemeDescriptor[] = [
  // 主题名不参与翻译（见 ThemeDescriptor.label 的说明）
  { id: BUILTIN_DARK_THEME, label: 'NIDE Dark', palette: 'dark' },
  { id: BUILTIN_LIGHT_THEME, label: 'NIDE Light', palette: 'light' }
]

/**
 * 每种配色的**窗口底色**。
 *
 * 给 `BrowserWindow` 的 `backgroundColor` 用，也就是在 CSS 之外决定"窗口本身"是什么
 * 颜色。首帧不靠它（窗口是 `ready-to-show` 之后才 show 的），它管的是**页面之外与
 * 页面重绘之前**露出来的地方：拖动改大窗口时新露出的那块、合成器还没跟上时的窗口背景。
 *
 * 值必须与样式表里两种配色的页面底色一致（深色 = `#18181b` 见 index.css 的 body，
 * 浅色 = `#ffffff` 见 light.css），否则上面那些地方会露出异色。
 */
export const THEME_WINDOW_COLORS: Record<ThemePalette, string> = {
  dark: '#18181b', // zinc-900
  light: '#ffffff'
}

/** 没有偏好时的地板 */
export const BASE_THEME_PALETTE: ThemePalette = 'dark'

/** 某个 id 的主题；认不出来时返回 null（调用方决定怎么回落） */
export function findBuiltinTheme(theme: ThemeId): ThemeDescriptor | null {
  return BUILTIN_THEMES.find((entry) => entry.id === theme) ?? null
}

/** 某个 id 的深浅；认不出来时按深色算 —— 深色是"什么都不挂"的那套，最保守 */
export function paletteOf(theme: ThemeId): ThemePalette {
  return findBuiltinTheme(theme)?.palette ?? BASE_THEME_PALETTE
}
