import { JSX, useRef } from 'react'

interface Props {
  axis: 'x' | 'y'
  /** 拖拽增量（px），向右/向下为正 */
  onDelta: (deltaPx: number) => void
  /** 双击分隔条时恢复该尺寸的默认值 */
  onReset?: () => void
}

/**
 * 可拖拽分隔条。
 *
 * 用 pointer capture 而不是往 window 上挂 mousemove：拖到窗口外也不会丢事件，
 * 也不用在卸载时清理监听。
 *
 * 视觉上只有 1px（兼任相邻面板的边界线），但用 ::after 把可抓取范围撑到 12px ——
 * 否则 1px 的分隔条几乎点不中。
 */
export function Resizer({ axis, onDelta, onReset }: Props): JSX.Element {
  const last = useRef(0)

  const hitArea =
    axis === 'x'
      ? "after:absolute after:inset-y-0 after:-left-1.5 after:w-3 after:content-['']"
      : "after:absolute after:inset-x-0 after:-top-1.5 after:h-3 after:content-['']"

  return (
    <div
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      onPointerDown={(e) => {
        // 阻止拖拽时选中文本
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        last.current = axis === 'x' ? e.clientX : e.clientY
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        const cur = axis === 'x' ? e.clientX : e.clientY
        const delta = cur - last.current
        if (delta === 0) return
        last.current = cur
        onDelta(delta)
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId)
        }
      }}
      onDoubleClick={onReset}
      className={[
        'relative z-20 shrink-0 touch-none select-none bg-zinc-800 transition-colors hover:bg-blue-500',
        axis === 'x' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
        hitArea
      ].join(' ')}
    />
  )
}
