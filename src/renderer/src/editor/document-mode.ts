import { isMarkdownPath, isChapterDocument, type ChapterMetadata } from '@shared/project'
import type { DocumentViewMode } from '@renderer/stores/document-view.store'

/**
 * 「这一篇在编辑器里能怎么看」的判据。
 *
 * 三件事都只由**文件自己**决定（扩展名 + frontmatter 里的类别），与它在哪个目录里、
 * 当前项目配置成什么样都无关 —— 一个放在 `chapters/` 里的 README 是 README，一个
 * 放在项目根的 `第3章.md` 只要写着类别就是章节。
 *
 * 放在这个文件里而不是散在组件中：工具栏要按它决定画几个按钮、正文要按它决定渲染
 * 哪一种视图、默认值也要按它算 —— 三处各写一遍判据，迟早会有一处分叉。
 */

/** 这一篇能不能用 Markdown 预览（也就是：界面要不要给出那几个视图按钮） */
export function canPreviewDocument(language: string, path: string): boolean {
  return language === 'markdown' || isMarkdownPath(path)
}

/**
 * 这一篇是不是章节（要不要给表单）。
 *
 * 判据是 frontmatter 里的类别，**不是**它在不在章节目录里：用户在章节目录里放一篇
 * 写作笔记是常态，而给笔记弹一个「索引 / 细纲」表单只是噪声。
 */
export function isChapterTab(language: string, path: string, metadata: ChapterMetadata): boolean {
  return canPreviewDocument(language, path) && isChapterDocument(metadata)
}

/**
 * 打开一个文件时默认落在哪个模式。
 *
 * 三条：
 *
 * - **章节默认表单**：写作时最常改的是索引、细纲、备注这些元数据，而正文本来就在
 *   旁边（表单里带着正文编辑器）；
 * - **其余 Markdown 默认预览**：没有类别的 Markdown 多半是文档（README、笔记），
 *   打开它是为了读，不是为了改；
 * - **非 Markdown 一律纯文本**：预览按钮根本不会出现（见 canPreviewDocument）。
 */
export function defaultDocumentMode(
  language: string,
  path: string,
  metadata: ChapterMetadata
): DocumentViewMode {
  if (!canPreviewDocument(language, path)) return 'text'
  return isChapterDocument(metadata) ? 'form' : 'preview'
}
