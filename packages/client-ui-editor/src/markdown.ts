import { Marked } from 'marked'

/**
 * Markdown -> HTML。
 *
 * 渲染交给 `marked`（CommonMark 那一档里最成熟、用得最广的实现之一，见 package.json
 * 的 dependencies）。这一层只做三件事：定下 marked 的配置、把输入里的原始 HTML 转义
 * 掉、以及把它收敛成一个纯函数（`renderMarkdown`）—— 组件之外的地方也能测，不必起
 * 一个 DOM。
 *
 * ## 元数据不进预览
 *
 * 传进来的必须是**正文**（`chapterBodyOf` 摘掉 frontmatter 之后的那一部分，见
 * MarkdownPreview）。这不是省事，而是因为 **marked 里没有任何 frontmatter 概念**：
 * 直接喂整篇的话，开头那个 `---` 会被读成水平线，后面的 `category: chapter` 会被读成
 * setext 标题（`<h2>`）—— 元数据就这样印在预览上。所以「不显示元数据」必须在渲染
 * **之前**把那一块摘掉，而摘它的规则只有一处（shared/project 的 splitFrontmatter）。
 *
 * ## 原始 HTML 一律转义
 *
 * marked 默认原样放行 Markdown 里的 HTML（`html: false` 也只管块级，内联的
 * `<img onerror=…>` 照样通过 —— 这一点是实测出来的）。所以这里在 token 树上把
 * **所有** `html` token 的值转义一遍再渲染：写 `<br>` 的人看到的是 `<br>` 这五个
 * 字符，他会立刻明白预览不支持它，而不是以为预览坏了。
 *
 * 实例是模块级的、只配一次：每渲染一次就 `use` 一遍会让 marked 的扩展表无限增长。
 */
const parser = new Marked({ gfm: true, breaks: false })

/** HTML 转义：`&` 要第一个换，否则会把后面换出来的实体再转一遍 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 走一遍 token 树，把 html token 的值转义掉。嵌套的 token（强调、列表项）也要进去 */
function escapeHtmlTokens(tokens: readonly unknown[]): void {
  for (const token of tokens as {
    type?: string
    text?: string
    tokens?: unknown[]
    items?: unknown[]
  }[]) {
    if (token.type === 'html' && typeof token.text === 'string') token.text = escapeHtml(token.text)
    if (Array.isArray(token.tokens)) escapeHtmlTokens(token.tokens)
    if (Array.isArray(token.items)) escapeHtmlTokens(token.items)
  }
}

/**
 * 把一段 Markdown **正文**渲染成 HTML 字符串。
 *
 * 输入不可信（用户自己的稿子，以及将来从别处粘进来的文本），所以这里的立场是
 * 「只认 Markdown 自己那一套语法」：Markdown 之外的标签一律是文字。
 */
export function renderMarkdown(source: string): string {
  if (typeof source !== 'string' || source.length === 0) return ''

  // 先切成一棵 token 树，转义掉原始 HTML，再渲染 —— 两步式的接口由 marked 提供
  // （lexer / parser），比在渲染钩子里拦更全：内联与块级都走同一条路。
  const tokens = parser.lexer(source)
  escapeHtmlTokens(tokens)

  return parser.parser(tokens)
}
