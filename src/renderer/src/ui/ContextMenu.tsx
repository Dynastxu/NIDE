import { JSX, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MenuItemRow, SubmenuRow, type MenuItem } from '@renderer/ui/MenuItem'

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

/**
 * 会展开子菜单的菜单项。
 *
 * 子菜单**只有一层**：再深一层就要开始处理「斜着移过去的路上经过别的行」这类问题，
 * 而右键菜单里的动作本来就不该多到需要两级以上。带子菜单的项没有 `onSelect` ——
 * 点它是展开，不是执行（见 SubmenuRow）。
 */
export interface ContextSubmenuItem {
  id: string
  label: string
  icon?: string
  items: ContextMenuItem[]
}

export type ContextMenuEntry = ContextMenuItem | ContextSubmenuItem

function isSubmenu(entry: ContextMenuEntry): entry is ContextSubmenuItem {
  return 'items' in entry
}

export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: ContextMenuEntry[]
  onClose: () => void
}): JSX.Element {
  // 点外面 / Esc / 窗口失焦都关掉。mousedown 而不是 click：
  // 右键菜单要「按下别处就消失」，等 click 会有一下迟滞感
  useEffect(() => {
    const onDown = (event: MouseEvent): void => {
      // 子菜单也在这棵树里，所以 contains 能一起盖住；点菜单内部的任何地方都不关
      if (menuRootRef.current?.contains(event.target as Node)) return
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

  /**
   * 整棵菜单（面板 + 展开的子菜单）的根节点。
   *
   * 子菜单用 `fixed` 定位，无法靠 DOM 嵌套让 `contains` 认出它，所以我们自己把它
   * 包成一个元素：`contains` 只看 DOM 结构，不看定位方式。
   */
  const menuRootRef = useRef<HTMLDivElement>(null)

  return (
    <div ref={menuRootRef}>
      <MenuPanel x={x} y={y} items={items} onClose={onClose} />
    </div>
  )
}

/**
 * 一层菜单面板：只画面板、定位、边缘翻转与子菜单展开，**不挂全局关闭监听**。
 *
 * 拆出来的理由：子菜单也要长成这个样子，但它不能各自去挂一份 document 级监听
 * （一份就够，多份会让「点一下子菜单」同时触发几次关闭）。关闭由最外层的
 * ContextMenu 统一负责。
 */
function MenuPanel({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: ContextMenuEntry[]
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

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
      {items.map((item) =>
        isSubmenu(item) ? (
          <SubmenuEntry key={item.id} item={item} onClose={onClose} />
        ) : (
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
        )
      )}
    </div>
  )
}

/**
 * 一个会展开子菜单的行，以及它的子菜单。
 *
 * 子菜单**不嵌在被 hover 的那一行里面**：菜单面板有上下内边距，嵌进去会从那一行的
 * **底边**开始往下画，而不是与它顶边对齐。所以按行的真实位置单独定位。
 *
 * 贴右边缘时整块翻到左侧：工具区本来就不宽，子菜单一律往右展开很容易出界。
 */
function SubmenuEntry({
  item,
  onClose
}: {
  item: ContextSubmenuItem
  onClose: () => void
}): JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  // 先展开、量到宽度，再决定往哪边放 —— 与顶层菜单同一条理由
  useLayoutEffect(() => {
    if (!open) return

    const row = rowRef.current
    if (!row) return

    const rect = row.getBoundingClientRect()
    const width = panelRef.current?.getBoundingClientRect().width ?? 160
    const gap = 4

    setPos({
      x:
        rect.right + width + gap > window.innerWidth
          ? Math.max(gap, rect.left - width)
          : rect.right,
      y: rect.top
    })
  }, [open])

  return (
    <>
      <div ref={rowRef} onMouseEnter={() => setOpen(true)}>
        <SubmenuRow
          label={item.label}
          {...(item.icon ? { icon: item.icon } : {})}
          expanded={open}
          onHover={() => setOpen(true)}
          onToggle={() => setOpen((value) => !value)}
        />
      </div>

      {open && (
        /*
         * 移出整块（行 + 子菜单）才收起：鼠标从行斜着移进子菜单的路上会经过别的行，
         * 那段路上不该把它关掉。用一层 wrapper 承载这个判断，面板自己不管关闭。
         */
        <div
          ref={panelRef}
          onMouseLeave={() => setOpen(false)}
          style={{ left: pos.x, top: pos.y }}
          className="fixed z-50"
        >
          {/* 子菜单不需要自己的边缘翻转：位置已经在这里算好了 */}
          <div
            role="menu"
            aria-label={item.label}
            className="min-w-[160px] rounded-md border border-zinc-700 bg-zinc-800 py-1 shadow-xl shadow-black/40"
          >
            {item.items.map((child) => (
              <MenuItemRow
                key={child.id}
                item={{
                  ...child,
                  // 与顶层行同一条：先关掉整棵菜单，再执行动作
                  onSelect: () => {
                    onClose()
                    child.onSelect()
                  }
                }}
              />
            ))}
          </div>
        </div>
      )}
    </>
  )
}
