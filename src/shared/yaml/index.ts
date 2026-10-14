/**
 * 宿主自己用的那一档最小 YAML。
 *
 * 只认「顶层、`键: 值`、值是标量字符串」这一种写法。刻意**不**引入 YAML 库：
 * 宿主读写这些文件的两端（`.nide/config.yml`、章节 Markdown 的 frontmatter）都是
 * 宿主自己，格式由这里定义；换一个库就等于把「文件会不会被解析成别的形状」押在
 * 依赖的版本上。副作用是这一层在渲染进程里也能跑（不会把一份解析器打进前端包）。
 *
 * 手写文件的容错分两档，由调用方选：
 *
 * - **严格**：`parseYamlScalar` 对 `true` / 数字 / 锚点这类「YAML 里有别的类型」的值
 *   返回 null。整份文件由调用方判定作废（配置文件就是这么办的：悄悄替用户认下一个
 *   别的值，比拒绝更糟）。
 * - **宽松**：`parseYamlTextValue` 对读不成字符串的值返回 null，调用方**跳过这一行**
 *   继续读别的（frontmatter 就是这么办的：一行写坏不该让整个章节标题失效）。
 *
 * 这一层被主进程与渲染进程共用，所以不能 import electron / fs / DOM。
 */

/**
 * YAML 里表示「结构」而不是「字符串」的开头字符（锚点、别名、流式集合、块标量、
 * 标签、指令）。这样的值交给别的解析器会被读成另一种东西 —— 本模块只认字符串，
 * 所以一律判为读不出来，而不是猜一个值出来。
 */
const YAML_STRUCTURAL_HEAD = /^[&*!|>%@`{}[\]]/

/** 值里的双引号与反斜杠需要转义，否则写出来的 YAML 读到的是另一个值 */
export function quoteYamlValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 读一个双引号标量。不是这一档写法（缺引号、控制字符夹在中间）给 null */
export function unquoteYamlValue(raw: string): string | null {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return null

  let result = ''
  for (let index = 1; index < raw.length - 1; index++) {
    const char = raw[index]

    if (char !== '\\') {
      result += char
      continue
    }

    // 反斜杠只能引出 `\"` 与 `\\`，其余写法不认（宁可不认，也不要猜）
    const next = raw[index + 1]
    if (next !== '"' && next !== '\\') return null

    result += next
    index++
  }

  return result
}

/**
 * 取一个 YAML 标量，读不成字符串给 null。
 *
 * 两种写法：本模块写出来的双引号标量，以及人手写的普通标量（`chapters: chapters`）。
 * 后者也收，是因为这些文件都是给人改的 —— 改配置不该被迫先学会引号。但只收**能确定
 * 是字符串**的那些：
 *
 * - 控制字符（含换行、制表）不该出现在这样的值里：换个编码或插了换行的行，不该被
 *   当成一个正常的名字；
 * - 单引号写法不认（本模块不写它，而认它就得连带处理它那套转义）；
 * - `true` / `null` / `~` / 数字在 YAML 里有别的类型，按字符串收下等于替用户改了
 *   他写的东西。
 *
 * 关掉 no-control-regex 是**刻意**的，与 files.ts 的名字校验同理 —— 那条规则防的是
 * 「拿控制字符当分隔符」，这里正是要匹配它们。
 */
export function parseYamlScalar(raw: string): string | null {
  if (raw.startsWith('"')) return unquoteYamlValue(raw)
  if (raw.startsWith("'")) return null
  if (raw.length === 0) return null

  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null
  if (YAML_STRUCTURAL_HEAD.test(raw)) return null

  // 去引号之后 YAML 会把它读成别的类型，而不是字符串
  if (/^(true|false|null|~)$/i.test(raw)) return null
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw)) return null

  return raw
}

/**
 * 读一行 `键: 值`，读不成给 null。
 *
 * 两种值写法都收（加引号的、以及能确定是字符串的裸标量），这是**宽松**那一档 ——
 * frontmatter 用它：读者只关心自己认得的那几个键，别的行读不出来就跳过。
 */
export function parseYamlTextValue(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.startsWith('"')) return unquoteYamlValue(trimmed)

  const scalar = parseYamlScalar(trimmed)
  return scalar === null ? null : scalar
}
