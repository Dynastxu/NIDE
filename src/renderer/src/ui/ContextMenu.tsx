import { JSX, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MenuItemRow, type MenuItem } from '@renderer/ui/MenuItem'

/**
 * 通用右键菜单。
 *
 * 放在 `ui/` 而不是某个具体功能的目录下：菜单的定位、点外关闭、Esc 关闭、
 * 边缘翻转这一套逻辑和「菜单里有什么」完全无关 —— 目前的使用方是插件列表与欢迎
 * 窗口的项目列表。
 *
 * **菜单行与下拉菜单共用同一个组件**（`@renderer/ui/MenuItem`），所以图标位、置灰、
 * danger 配色、内边距这些只有一份定义。
 *
 * 定位用**测量后翻转**而不是猜一个高度：菜单项数量是可变的，猜错就会顶出窗口
 * （正是之前设置窗口跑到屏幕外那类问题的同一个根源 —— 拿一个假定的尺寸去算位置）。
 * 先渲染在请求的位置、量到真实尺寸、超出边界再翻到反方向。
 */
export type ContextMenuItem = MenuItem

export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // 点外面 / Esc / 窗口失焦都关掉。mousedown 而不是 click：
  // 右键菜单要「按下别处就消失」，等 click 会有一下迟滞感
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      if (ref.current?.contains(event.target as Node)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  // 量真实尺寸后再决定要不要翻转。用 layout effect：必须在浏览器绘制前定好位置，
  // 否则会看到菜单从右边缘「跳」回左边
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const { width, height } = element.getBoundingClientRect()
    const gap = 8

    setPos({
      x: x + width + gap > window.innerWidth ? Math.max(gap, x - width) : x,
      y: y + height + gap > window.innerHeight ? Math.max(gap, y - height) : y
    })
  }, [x, y])

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 min-w-[160px] rounded-md border border-zinc-700 bg-zinc-800 py-1 shadow-xl shadow-black/40"
    >
      {items.map((item) => (
        // 选中之后先关掉菜单再执行：动作可能换窗口 / 拆窗口，留着菜单只会让「菜单还在
        // 而它指向的东西已经没了」这种状态出现
        <MenuItemRow
          key={item.id}
          item={{
            ...item,
            onSelect: () => {
              onClose()
              item.onSelect()
            }
          }}
        />
      ))}
    </div>
  )
}
