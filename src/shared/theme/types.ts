/**
 * 主题契约：宿主三个进程共用的一份定义。
 *
 * 这一层被主进程、preload、渲染进程共用，所以**不能** import electron / DOM。
 *
 * ## 主题是什么
 *
 * 一套主题 = **一个 id + 一个名字 + 一个"深还是浅"的标记**。
 *
 * 配色本身**不在数据里**，而在样式表里：
 * - 深色 = 组件里那些原始色阶（`bg-zinc-900` …）+ `assets/index.css`；
 * - 浅色 = `assets/light.css`，把前者**逐条翻译**一遍（靠 `.theme-light` 前缀生效）。
 *
 * 这样分的好处：组件写色阶，浅色主题是它的翻译，所以"换主题"在渲染进程侧只是给
 * 根元素换一个类名 —— 不可能出现"某个窗口忘了跟"。主进程需要知道的也只有三件事：
 * 有哪些可选、当前那套是深是浅（决定 `nativeTheme.themeSource` 与原生对话框的明暗）、
 * 以及窗口建出来时该用什么底色。
 *
 * 插件目前**不能**贡献主题：主题要自带配色，而配色现在还是样式表里的具体色阶。
 * 等色阶换成可注入的变量之后，这里才会多出"贡献点"那条路。
 */

/**
 * 主题标识。
 *
 * `builtin.` 前缀留给宿主自己。
 */
export type ThemeId = string

export const BUILTIN_DARK_THEME: ThemeId = 'builtin.dark'
export const BUILTIN_LIGHT_THEME: ThemeId = 'builtin.light'

/** 没有偏好、或偏好指向的主题不存在时用它 */
export const DEFAULT_THEME: ThemeId = BUILTIN_DARK_THEME

/**
 * 这套配色是深是浅。
 *
 * 它不是外观数据，而是"关于这套配色的事实"：主进程拿它设 `nativeTheme.themeSource`
 * （原生对话框、日期选择器、滚动条）与窗口底色；渲染进程拿它决定根元素挂哪个类。
 */
export type ThemePalette = 'dark' | 'light'

/** 可展示给用户的一条主题记录 */
export interface ThemeDescriptor {
  id: ThemeId
  /**
   * 主题在设置页里的名字。
   *
   * 和语言的「自称」同一条约定：**不参与翻译体系**。主题名是它自己的一部分
   * （"Solarized Light" 翻成中文只会让人对不上眼），所以这里不放词条 key。
   */
  label: string
  palette: ThemePalette
}

/**
 * 主进程 -> 渲染进程的完整主题载荷（纯数据，可结构化克隆）。
 *
 * 渲染进程不需要读盘、也不需要懂配色：它拿到的就是「可选哪些、现在用哪个、
 * 那个是深是浅」这三件事的结论。
 */
export interface ThemePayload {
  /** 最终生效的主题 id */
  theme: ThemeId
  /** 实际生效的深浅。渲染进程按它挂根元素的类名 */
  palette: ThemePalette
  /** 所有可切换的主题，已按「深色在前」排好 */
  available: ThemeDescriptor[]
  /**
   * 用户请求的主题没找到时，这里记录被放弃的那个 id。有值就说明发生了回落，
   * 界面应当给出可见提示（对应 i18n 的 fallbackFrom）。
   */
  fallbackFrom?: ThemeId
}
