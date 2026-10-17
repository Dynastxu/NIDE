import { JSX, type ReactNode } from 'react'

/**
 * 表单里的两种控件：一行「标签 + 控件」，以及一个多行文本框。
 *
 * 抽出来是因为现在有**三份**表单共用同一种排版（章节、图鉴条目、图鉴字段表）：三处
 * 各写一份的话，标签宽度、字号与聚焦样式迟早会分叉，而那种差别只会在用户来回切表单时
 * 看出来 —— 那时谁也不知道哪一份才是「对的」。
 *
 * 样式与行为都刻意保持最小：宽度、留白由调用方那一层给（见 EditorPanes 的表单分支），
 * 这里只管一行怎么排。
 */

/** 一个字段：左边固定宽度的标签（可带一句说明），右边控件 */
export function FormField({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex min-w-0 gap-3">
      <div className="flex w-20 shrink-0 flex-col gap-0.5 pt-1">
        <span className="text-xs break-words text-zinc-300">{label}</span>
        {hint && <span className="text-[10px] leading-3 text-zinc-500">{hint}</span>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** 多行文本字段。样式统一在这里，调用点只给值与回调 */
export function FormTextArea({
  value,
  onChange,
  onBlur,
  placeholder,
  rows = 3
}: {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  placeholder?: string
  /** 行数。字段表那种一行一个的输入用小值，正文那种长文本用默认值 */
  rows?: number
}): JSX.Element {
  return (
    <textarea
      value={value}
      rows={rows}
      onChange={(event) => onChange(event.target.value)}
      {...(onBlur ? { onBlur } : {})}
      placeholder={placeholder}
      className="nide-scrollbar w-full resize-y rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs leading-5 text-zinc-100 outline-none focus:border-blue-500"
    />
  )
}
