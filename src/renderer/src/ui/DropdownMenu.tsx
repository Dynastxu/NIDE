import { JSX } from 'react'
import { MenuItemRow, type MenuItem } from '@renderer/ui/MenuItem'

/**
 * 下拉菜单面板：一列菜单行 + 统一的浮层外观（边框、底色、阴影、圆角）。
 *
 * **只画面板，不管定位**：调用方用 `className` 传定位（菜单栏的子菜单挂在菜单项下方、
 * 标题栏的设置下拉挂在按钮下方、右键菜单甚至是 `fixed` 跟着指针走）。把定位也塞进来
 * 就得发明一套「位置模式」参数，而那正是各调用点各不相同的那一半。
 *
 * 行的渲染见 `MenuItem`：它同时被右键菜单复用，所以「菜单长什么样」只有一处定义。
 */
export function DropdownMenu({
  items,
  className = '',
  ariaLabel
}: {
  items: MenuItem[]
  /** 定位相关的类（`absolute top-full left-0 z-50 mt-1` 之类） */
  className?: string
  ariaLabel?: string
}): JSX.Element {
  return (
    <div
      role="menu"
      aria-label={ariaLabel}
      className={[
        'min-w-[180px] rounded-md border border-zinc-700 bg-zinc-800 py-1 shadow-xl shadow-black/40',
        className
      ]
        .join(' ')
        .trim()}
    >
      {items.map((item) => (
        <MenuItemRow key={item.id} item={item} />
      ))}
    </div>
  )
}
