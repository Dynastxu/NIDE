import { JSX, useState, type ReactNode } from 'react'

/**
 * 可折叠的一段：一个标题行 + 可展开的内容。
 *
 * 与设置窗口的左树不同，这里是**就地展开**的一段内容（一节一项地列出来），所以
 * 用的是「标题行本身就是开关」这一档，而不是另画一个三角按钮 —— 后者的点击区比
 * 文字小得多，而这一层里每一行都是用户会去点的地方。
 *
 * 受控与否都支持：`defaultOpen` 只在内部状态模式下有意义（与浏览器原生 `<details>`
 * 的习惯一致），需要由外部决定展开状态的调用方传 `open` + `onToggle`。
 */
export function Disclosure({
  title,
  summary,
  defaultOpen = true,
  open,
  onToggle,
  children
}: {
  /** 标题行左侧的文字 */
  title: ReactNode
  /** 标题行右侧的摘要（数量之类），可省略 */
  summary?: ReactNode
  defaultOpen?: boolean
  open?: boolean
  onToggle?: (next: boolean) => void
  children: ReactNode
}): JSX.Element {
  const [inner, setInner] = useState(defaultOpen)
  const expanded = open ?? inner

  const toggle = (): void => {
    const next = !expanded
    if (open === undefined) setInner(next)
    onToggle?.(next)
  }

  return (
    <div className="flex min-h-0 flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={toggle}
        className="flex w-full shrink-0 items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-medium tracking-wide text-zinc-400 uppercase transition-colors hover:bg-zinc-800/60 hover:text-zinc-200"
      >
        {/* 展开方向用旋转的箭头表示，不额外占一个图标位 */}
        <span
          aria-hidden="true"
          className={[
            'inline-block transition-transform',
            expanded ? 'rotate-90' : 'rotate-0'
          ].join(' ')}
        >
          ›
        </span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {summary !== undefined && <span className="shrink-0 text-zinc-500">{summary}</span>}
      </button>

      {expanded && <div className="flex min-h-0 flex-col pb-1">{children}</div>}
    </div>
  )
}
