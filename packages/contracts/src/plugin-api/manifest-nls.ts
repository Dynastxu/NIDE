/**
 * 插件 **manifest 文案**本地化的约定（照抄 VS Code）。
 *
 * manifest 里写 `%key%` 占位符，插件目录下放：
 *
 *   package.nls.json           插件自己声明的默认语言，最后一档回落
 *   package.nls.<locale>.json  某个语言的翻译，例如 package.nls.en-US.json
 *
 * 只有**整串**被 % 包住才算占位符，所以 "100% done" 这种标题不会被误判。
 *
 * 这条约定要被两边同时用到：host 读文件（文件名规则），shell 解析标题（占位符识别）。
 * 所以规则本身放在这一层 —— 它没有运行时依赖，host 的纯 Node ESM 能直接加载。
 */

/** 默认词条文件名（插件自己声明的语言） */
export const DEFAULT_NLS_FILE = 'package.nls.json'

/** `package.nls.<locale>.json` 的文件名规则 */
export const NLS_FILE_RE = /^package\.nls\.(.+)\.json$/

const PLACEHOLDER_RE = /^%(.+)%$/

/** 只在整串被 % 包住时才算占位符 */
export function parsePlaceholder(spec: string): string | null {
  const match = PLACEHOLDER_RE.exec(spec)
  return match ? match[1] : null
}
