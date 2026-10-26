import { JSX, useEffect, useRef } from 'react'
import {
  MAX_GALLERY_FIELDS,
  validateGalleryField,
  type InvalidGalleryFieldReason
} from '@nide/contracts/project'
import { applyGalleryConfig, syncGalleryForm } from '@nide/client-ui-main/editor/gallery-metadata'
import { BuiltinIcon } from '@nide/client-kit/ui/BuiltinIcon'
import { useT } from '@nide/client-kit/stores/i18n.store'
import type { EditorTab } from '@nide/client-kit/stores/editor.store'
import type { HostMessageKey } from '@nide/contracts/i18n'

/**
 * 图鉴字段表的表单（`config.yml`）：一行一个字段，可加可删。
 *
 * ```
 * 图鉴字段
 * 第一个字段用来当条目的名字。
 * ┌──────────────┐
 * │ 名称          │ ×     ← 第一个字段：条目的名字
 * └──────────────┘
 * ┌──────────────┐
 * │ 外貌          │ ×
 * └──────────────┘
 * [＋ 添加字段]
 * ```
 *
 * ## 写的是**原文**，包括还没敲完的那个名字
 *
 * 每次输入直接把整张字段表写回文件（见 applyGalleryConfig），因此磁盘上会出现「用户
 * 正在敲到一半」的名字（甚至一个空名字）。这是刻意的取舍：
 *
 * - 名字是任意文本，没有「合法 / 非法」之分可言（章节的索引有：`1` 不是一个号）；
 * - 而**读不出来**的代价要大得多 —— 一份读不出来的 `config.yml` 会让这个图鉴的条目
 *   失去全部字段（见 renderer 的 document-mode）。所以这里宁可在文件里留一个空名字，
 *   也不让表单在用户敲字时消失。名字为空这一条由**内联提示**说出来（见下面的 warning），
 *   条目的表单会跳过空名字（见 galleryEntryFields）。
 *
 * ## 字段名的改动会留下旧键
 *
 * 改一个字段名之后，已经写好的条目里那个旧键还在。**不做迁移**：宿主没有任何依据知道
 * 「外貌」与「外观」是同一个字段（用户完全可能是真的换了一个），而批量改写用户文件是
 * 不可撤销的。旧键会作为「多出来的字段」继续显示在条目表单里（见 GalleryEntryForm），
 * 用户自己决定什么时候把它们清掉。
 */
export function GalleryConfigForm({
  tab,
  syncing
}: {
  tab: EditorTab
  /** 「这次 model 写入是宿主发起的」标记，与编辑器那一层共用同一个 */
  syncing: { current: boolean }
}): JSX.Element {
  const t = useT()
  const fields = tab.galleryConfig?.fields ?? []

  /** 每一个输入框，用来把焦点放进刚加出来的那一个 */
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  /** 下一次渲染之后要把焦点放到第几个输入框；null 表示不用放 */
  const focusAt = useRef<number | null>(null)

  // 表单模式里没有编辑器，model 得有人建出来并对齐（见 gallery-metadata 的说明）
  useEffect(() => {
    syncGalleryForm(
      {
        path: tab.path,
        language: tab.language,
        originalValue: tab.originalValue,
        content: tab.content
      },
      syncing
    )
  }, [tab.path, tab.language, tab.originalValue, tab.content, syncing])

  /**
   * 加字段之后把焦点放进那个新输入框。
   *
   * 写在 effect 里而不是 `addField` 里：那一刻新输入框还没渲染出来。依赖表为空 ——
   * 每渲染一次就检查一次，而 `focusAt` 只在那一次被置上值。
   */
  useEffect(() => {
    const index = focusAt.current
    if (index === null) return

    focusAt.current = null
    inputs.current[index]?.focus()
  })

  const commit = (next: readonly string[]): void => {
    applyGalleryConfig(tab.path, next, syncing)
  }

  const addField = (): void => {
    if (fields.length >= MAX_GALLERY_FIELDS) return

    focusAt.current = fields.length
    commit([...fields, ''])
  }

  const renameField = (index: number, name: string): void => {
    commit(fields.map((field, position) => (position === index ? name : field)))
  }

  /**
   * 失焦时把首尾空白去掉。
   *
   * 字段名两端的空格在界面上看不出来，而它会写进文件、也会让「这个名字是不是已经有了」
   * 判不出来（`名称` 与 `名称 ` 是两个字符串）。只在真的多出空白时才写一次。
   */
  const trimField = (index: number, name: string): void => {
    const trimmed = name.trim()
    if (trimmed === name) return

    renameField(index, trimmed)
  }

  const removeField = (index: number): void => {
    commit(fields.filter((_, position) => position !== index))
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-xs font-medium text-zinc-300">
          {t('host.editor.gallery.config.title')}
        </h3>
        <p className="text-[11px] leading-4 text-zinc-500">
          {t('host.editor.gallery.config.hint')}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {fields.map((field, index) => (
          <FieldRow
            key={index}
            index={index}
            value={field}
            /* 重名只在**别的**字段里找：与自己比永远是重名 */
            otherFields={fields.filter((_, position) => position !== index)}
            inputRef={(element) => {
              inputs.current[index] = element
            }}
            onChange={(name) => renameField(index, name)}
            onBlur={(name) => trimField(index, name)}
            onRemove={() => removeField(index)}
          />
        ))}
      </div>

      <div>
        <button
          type="button"
          disabled={fields.length >= MAX_GALLERY_FIELDS}
          /* 到上限时说明为什么点不动：一个没有解释的禁用按钮只会让人反复点它 */
          title={
            fields.length >= MAX_GALLERY_FIELDS
              ? t('host.editor.gallery.config.add.disabled')
              : undefined
          }
          onClick={addField}
          className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-200 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:bg-zinc-800/60 disabled:text-zinc-600"
        >
          <BuiltinIcon name="plus" className="h-3 w-3" />
          {t('host.editor.gallery.config.add')}
        </button>
      </div>
    </section>
  )
}

/** 字段名非法原因 -> 词条 key */
const INVALID_FIELD_KEYS: Record<InvalidGalleryFieldReason, HostMessageKey> = {
  empty: 'host.editor.gallery.config.invalid.empty',
  'illegal-character': 'host.editor.gallery.config.invalid.illegal-character',
  'too-long': 'host.editor.gallery.config.invalid.too-long',
  duplicate: 'host.editor.gallery.config.invalid.duplicate'
}

/** 一行：一个输入框 + 一个删除按钮 +（必要时）一句提示 */
function FieldRow({
  index,
  value,
  otherFields,
  inputRef,
  onChange,
  onBlur,
  onRemove
}: {
  index: number
  value: string
  /** 除了自己以外的字段名，用来判重 */
  otherFields: readonly string[]
  inputRef: (element: HTMLInputElement | null) => void
  onChange: (value: string) => void
  onBlur: (value: string) => void
  onRemove: () => void
}): JSX.Element {
  const t = useT()
  const validation = validateGalleryField(value, otherFields)
  /** 空名字是「还没敲」，不是错误：默认字段就是空的时候不该一进来就红一片 */
  const warning =
    value.length > 0 && !validation.ok ? t(INVALID_FIELD_KEYS[validation.reason]) : null

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={(event) => onBlur(event.target.value)}
          aria-invalid={warning !== null}
          placeholder={t('host.editor.gallery.config.placeholder')}
          className="h-7 w-56 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100 outline-none focus:border-blue-500"
        />

        <button
          type="button"
          aria-label={t('host.editor.gallery.config.remove')}
          title={t('host.editor.gallery.config.remove')}
          onClick={onRemove}
          className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
        >
          <BuiltinIcon name="close" className="h-3 w-3" />
        </button>

        {/* 第一个字段就是条目的名字，这一句只说一次 */}
        {index === 0 && (
          <span className="text-[10px] leading-3 text-zinc-500">
            {t('host.editor.gallery.config.first')}
          </span>
        )}
      </div>

      {warning && <p className="text-[11px] leading-4 text-red-400">{warning}</p>}
    </div>
  )
}
