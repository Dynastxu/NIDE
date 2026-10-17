import { JSX } from 'react'
import { BuiltinIcon } from '@renderer/ui/BuiltinIcon'
import { useT } from '@renderer/stores/i18n.store'
import { useDocumentViewStore, type DocumentViewMode } from '@renderer/stores/document-view.store'
import type { HostMessageKey } from '@shared/i18n'

/**
 * 主视图标题栏上的视图模式切换（「更多」按钮左侧的那一组）。
 *
 * **哪几个按钮由调用方给**（`modes`）。这一层的判据在 `editor/document-mode.ts`：
 * 那里算的是「这一篇能怎么看」，这里只负责把那一组画出来 —— 两处各判一次迟早会分叉，
 * 而分叉的表现是「按钮说能填表单、正文却给了一段纯文本」（见那个文件的文件头）。
 *
 * ## 切换走 store，不走 props
 *
 * 模式按路径存在 `document-view.store` 里：工具栏与正文是两棵相距很远的子树，而它们
 * 读的是同一份状态。切换本身是「把这一篇的模式设成 X」，没有别的事要做。
 *
 * 当前选中哪一个也由调用方给（`mode`）：它同样是那一份结论的一部分（存着的模式可能
 * 已经不在这一组里了，要按同一个规则回落，见 resolveDocumentMode）。
 */
export function DocumentViewModes({
  path,
  modes,
  mode
}: {
  /** 当前文件路径。模式按它记 */
  path: string
  /** 这一篇能给的几种看法。顺序就是按钮的顺序 */
  modes: readonly DocumentViewMode[]
  /** 当前选中哪一个（已经按可用模式回落过） */
  mode: DocumentViewMode
}): JSX.Element {
  const t = useT()
  const setMode = useDocumentViewStore((s) => s.setMode)

  return (
    <div
      role="group"
      aria-label={t('host.editor.view.label')}
      className="flex items-center gap-0.5"
    >
      {modes.map((id) => {
        const item = MODE_BUTTONS[id]
        const active = id === mode
        const label = t(item.label)

        return (
          <button
            key={id}
            type="button"
            // aria-pressed 而不是 tab 语义：这是几个并列的开关，不是一个标签条
            aria-pressed={active}
            aria-label={label}
            title={label}
            onClick={() => setMode(path, id)}
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

/** 四种看法的图标与说法。写法固定，所以是一张表而不是四个分支 */
const MODE_BUTTONS: Record<DocumentViewMode, { label: HostMessageKey; icon: string }> = {
  text: { label: 'host.editor.view.text', icon: 'fileText' },
  form: { label: 'host.editor.view.form', icon: 'form' },
  split: { label: 'host.editor.view.split', icon: 'split' },
  preview: { label: 'host.editor.view.preview', icon: 'eye' }
}
