import { JSX } from 'react'
import { BuiltinIcon } from '@renderer/ui/BuiltinIcon'

/**
 * 菜单里的一行 —— 下拉菜单（`DropdownMenu`）与右键菜单（`ContextMenu`）共用同一份
 * 渲染与样式。
 *
 * **左侧固定一个图标位**：没给图标时留一个等宽空位，而不是让文字顶到最左边 ——
 * 否则同一个菜单里「有图标」和「没图标」的行文字左边缘会差一格，看起来像两套对齐。
 * 图标名走宿主的图标集（见 layout/icons），与插件视图用的是同一批字形。
 */
export interface MenuItem {
  id: string
  label: string
  /**
   * 内置图标名。**可以省略**：省略就是空位（例如「从列表移除」这类没有合适字形的项）。
   * @see BUILTIN_ICONS
   */
  icon?: string
  onSelect: () => void
  /** 置灰 */
  disabled?: boolean
  /** 置灰时鼠标悬停给出的原因 */
  disabledReason?: string
  danger?: boolean
}

/**
 * 会展开子菜单的那一行。
 *
 * 和普通行的差别有两处，都在这里定死，调用方不必自己拼：
 *
 * - **点它不执行动作**，只负责展开 / 收起（触控与键盘用户点得到，鼠标用户悬停即可）；
 * - 右侧固定一个箭头位，普通行留等宽空位 —— 否则同一列里「有子菜单」和「没子菜单」
 *   的行文字右边缘不齐，看起来像两套对齐（与左侧图标位同一条理由）。
 */
export function SubmenuRow({
  label,
  icon,
  expanded,
  onHover,
  onToggle
}: {
  label: string
  icon?: string
  expanded: boolean
  onHover: () => void
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={expanded}
      onMouseEnter={onHover}
      onClick={onToggle}
      className={[
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
        expanded ? 'bg-blue-600 text-white' : 'text-zinc-200 hover:bg-blue-600 hover:text-white'
      ].join(' ')}
    >
      <IconSlot name={icon} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {/* 箭头位：所有行都占住它，见文件头说明 */}
      <BuiltinIcon name="chevronDown" className="h-3 w-3 shrink-0 -rotate-90 opacity-70" />
    </button>
  )
}

export function MenuItemRow({ item }: { item: MenuItem }): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={item.disabled}
      title={item.disabled ? item.disabledReason : undefined}
      onClick={item.onSelect}
      className={[
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
        item.disabled
          ? 'cursor-not-allowed text-zinc-600'
          : item.danger
            ? 'text-zinc-200 hover:bg-red-600 hover:text-white'
            : 'text-zinc-200 hover:bg-blue-600 hover:text-white'
      ].join(' ')}
    >
      <IconSlot name={item.icon} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {/* 没有子菜单的行占住箭头位，见 SubmenuRow 的说明 */}
      <span aria-hidden="true" className="h-3 w-3 shrink-0" />
    </button>
  )
}

/** 图标位：有图标画图标，没图标留一个等宽空位（理由见文件头） */
function IconSlot({ name }: { name?: string }): JSX.Element {
  if (!name) return <span aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />

  return <BuiltinIcon name={name} className="h-3.5 w-3.5" />
}
