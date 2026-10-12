/**
 * 主题契约与内置主题。
 *
 * 配色本身在样式表里（深色 = 组件里的原始色阶，浅色 = `assets/light.css` 的翻译），
 * 这一层只说清"有哪些主题、各自深浅、窗口底色是什么" —— 见各文件的说明。
 */
export * from './types'
export * from './builtin'
