import { JSX } from 'react'
import { BuiltinIcon } from '@renderer/ui/BuiltinIcon'
import { useT } from '@renderer/stores/i18n.store'
import { useDocumentViewStore, type DocumentViewMode } from '@renderer/stores/document-view.store'
import { defaultDocumentMode, isChapterTab } from '@renderer/editor/document-mode'
import type { HostMessageKey } from '@shared/i18n'
import type { ChapterMetadata } from '@shared/project'

/**
 * 主视图标题栏上的视图模式切换（「更多」按钮左侧的那一组）。
 *
 * 只在**当前文件是 Markdown** 时出现（见 EditorPanes 的调用点）：纯文本文件没有预览
 * 可言，一组点了没反应的按钮不如不画。
 *
 * ## 表单只对章节出现
 *
 * 「章节」的判据是 frontmatter 里的类别（见 document-mode.ts）。不是章节的 Markdown
 * （README、笔记）因此看不到表单按钮 —— 一个会给普通文档补出 `category: chapter` 的
 * 表单，比没有表单糟得多。
 *
 * ## 切换走 store，不走 props
 *
 * 模式按路径存在 `document-view.store` 里：工具栏与正文是两棵相距很远的子树，而它们
 * 读的是同一份状态。切换本身是「把这一篇的模式设成 X」，没有别的事要做。
 */
export function DocumentViewModes({
  path,
  language,
  metadata
}: {
  /** 当前文件路径。模式按它记 */
  path: string
  /** Monaco 语言 id。与路径一起决定这一篇能不能预览 */
  language: string
  /** 当前这一篇的元数据。表单按钮要不要出现看它 */
  metadata: ChapterMetadata
}): JSX.Element {
  const t = useT()
  const selected = useDocumentViewStore((s) => s.modes[path])
  const setMode = useDocumentViewStore((s) => s.setMode)

  const mode = selected ?? defaultDocumentMode(language, path, metadata)
  const withForm = isChapterTab(language, path, metadata)

  /**
   * 四个模式里哪一个给哪个按钮。
   *
   * 表单那一项按 `withForm` 过滤：没有类别的 Markdown 只有三种看法，而它们已经够用了
   * （读 -> 预览、改 -> 纯文本、对照 -> 拆分）。
   */
  const modes: { id: DocumentViewMode; label: HostMessageKey; icon: string }[] = [
    { id: 'text', label: 'host.editor.view.text', icon: 'fileText' },
    { id: 'form', label: 'host.editor.view.form', icon: 'form' },
    { id: 'split', label: 'host.editor.view.split', icon: 'split' },
    { id: 'preview', label: 'host.editor.view.preview', icon: 'eye' }
  ]

  return (
    <div
      role="group"
      aria-label={t('host.editor.view.label')}
      className="flex items-center gap-0.5"
    >
      {modes
        .filter((item) => item.id !== 'form' || withForm)
        .map((item) => {
          const active = item.id === mode
          const label = t(item.label)

          return (
            <button
              key={item.id}
              type="button"
              // aria-pressed 而不是 tab 语义：这是四个并列的开关，不是一个标签条
              aria-pressed={active}
              aria-label={label}
              title={label}
              onClick={() => setMode(path, item.id)}
              className={[
                'flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors',
                active
                  ? 'bg-zinc-700 text-zinc-100'
                  : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
              ].join(' ')}
            >
              <BuiltinIcon name={item.icon} className="h-3.5 w-3.5" />
            </button>
          )
        })}
    </div>
  )
}
