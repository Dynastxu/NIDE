import { JSX, useMemo } from 'react'
import { renderMarkdown } from '@nide/client-ui-main/editor/markdown'
import { useT } from '@nide/client-kit/stores/i18n.store'
import { chapterBodyOf } from '@shared/project'

/**
 * Markdown 预览。
 *
 * 只做三件事：渲染、防溢出、跟随主题。排版规则写在 `assets/index.css` 的 `.nide-markdown`
 * 里，而不是在这里堆一串 Tailwind 类 —— 渲染出来的内容是 marked 生成的任意层级标签，
 * 用 utility 类逐个指定既写不全（`ul > li > p` 这种组合），也没法给后代选择器。
 *
 * ## 传进来的是整篇，渲染的是正文
 *
 * 组件收的是文件当前的全文（调用方手上只有那一份），而 `chapterBodyOf` 在渲染前把
 * frontmatter 摘掉：**预览里不出现元数据**。frontmatter 是给宿主读的（编号、细纲、
 * 备注），把它印在预览上既不像正文、也不像元数据 —— 而 marked 里没有任何 frontmatter
 * 概念，不摘的话那几行会被读成水平线加 setext 标题。
 *
 * ## 为什么可以直接塞 HTML
 *
 * 内容来自 `renderMarkdown`（见 editor/markdown.ts），那里已经把原始 HTML 全部转义
 * 掉了，所以这个字符串里的标签只有 marked 自己生成的那几种。这一层再逐标签过滤一遍
 * 只会带来第二处「哪些标签算安全」的判据。
 *
 * ## 链接点不开
 *
 * 宿主没有内嵌浏览器，点一条外链会跳出应用之外（甚至被 Electron 拦掉而毫无反应）。
 * 所以链接保留样式、去掉跳转：需要打开时由用户自己复制地址。
 */
export function MarkdownPreview({ content }: { content: string }): JSX.Element {
  const t = useT()

  /** 正文：摘掉 frontmatter 之后的那一部分。预览只认它 */
  const body = useMemo(() => chapterBodyOf(content), [content])

  /**
   * 渲染结果按正文缓存。
   *
   * 依赖是正文本身：预览每次重渲染都重跑一遍 marked，在长稿子上是实打实的开销，而
   * 这个组件会因为光标、标签页圆点这些与正文无关的变化被重新渲染。
   */
  const html = useMemo(() => renderMarkdown(body), [body])

  // 正文为空时不塞一个空 <article>：说清「这里还没有内容」比一片留白有用
  if (body.trim().length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <p className="text-xs text-zinc-500">{t('host.editor.preview.empty')}</p>
      </div>
    )
  }

  return (
    <div className="nide-scrollbar min-h-0 flex-1 overflow-auto">
      <article
        className="nide-markdown max-w-3xl px-6 py-4"
        onClick={(event) => {
          const anchor = (event.target as HTMLElement).closest('a')
          // 预览里的链接不跳转：跳出去会离开应用，留在原地说清为什么更有用
          if (anchor) event.preventDefault()
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
