/**
 * 主题契约与内置主题。
 *
 * 配色本身在样式表里，且只有一份语义 token 表：深色值在 `assets/index.css` 的
 * `@theme`，浅色值在 `assets/light.css` 的覆盖。这一层只说清"有哪些主题、各自深浅、
 * 窗口底色是什么" —— 见各文件的说明。
 */
export * from './types'
export * from './builtin'
