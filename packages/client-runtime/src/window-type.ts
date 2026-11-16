/**
 * 客户端窗口种类。
 *
 * 单独一个模块是为了让**生成的** roster 能引用它而不形成
 * `index.ts → roster → index.ts` 的循环。
 */
export type ClientWindowType = 'main' | 'welcome' | 'settings'
