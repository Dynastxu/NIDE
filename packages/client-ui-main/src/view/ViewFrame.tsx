import { JSX, useEffect, useRef, useState, type ReactNode } from 'react'
import { isZoneId, useLayoutStore, type ZoneId } from '@nide/client-kit/stores/layout.store'
import { useT } from '@nide/client-kit/stores/i18n.store'
import { BuiltinIcon } from '@nide/client-kit/ui/BuiltinIcon'
import { DropdownMenu } from '@nide/client-kit/ui/DropdownMenu'
import { useViewDescriptor } from '@nide/client-ui-main/view/view-descriptor'
import { ChromeSlot, ViewTabStripView } from '@nide/client-ui-main/view/ViewTabStrip'
import type { ViewChromeConfig } from '@nide/client-ui-main/view/chrome-context'
import type { ViewChromeSlots, ViewMoreItem } from '@shared/plugin-api'
import type { MenuItem } from '@nide/client-kit/ui/MenuItem'

/**
 * 视图外壳：标题栏 + 视图正文。
 *
 * 所有 ViewLocation 上的视图都长这样 —— 六个工具区与中间主编辑区走的是同一个组件。
 * 标题栏的**内容**由视图给（见 view/chrome-context 的 useViewChrome），这里只管
 * 怎么排、怎么点。
 *
 * 一行内的排布（从左到右）：
 *
 * ```
 * [标题] [标签条左按钮] [标签条] [标签条右按钮] [自定义按钮] [更多] [最小化]
 * ```
 *
 * 标题**不带图标**：图标位归侧边按钮条，标题栏这一行要让给标签与右端那两个按钮。
 *
 * 「标签右侧」与「更多左侧」是两个不同的挂载点，所以自定义按钮有两处：标签条右端
 * （`slots.tabs.after`，紧贴标签）和它们共同的右侧（`slots.actions`，紧贴更多按钮）。
 * 一个都没给时整行只剩标题与两个按钮，不会留下空洞。
 */
export function ViewFrame({
  chrome,
  slots,
  children
}: {
  /** 外壳配置（useViewChrome 的返回值之一） */
  chrome: ViewChromeConfig
  /** 视图自己挂的按钮。省略就是三处都不画 */
  slots?: ViewChromeSlots
  /** 视图正文 */
  children?: ReactNode
}): JSX.Element {
  const descriptor = useViewDescriptor()
  const t = useT()
  const zone = zoneOf(descriptor?.location)

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-zinc-950/30">
      {chrome.header && (
        <div className="flex h-7 shrink-0 items-stretch gap-1 border-b border-zinc-800 bg-zinc-900/60 pr-1 pl-2">
          {chrome.showTitle && <FrameTitle title={chrome.title} />}
          {chrome.showTitle && <ChromeSlot slot={slots?.title} />}

          {chrome.showTabs ? (
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <ChromeSlot slot={slots?.tabs?.before} />
              <TabStrip chrome={chrome} slots={slots} />
              <ChromeSlot slot={slots?.tabs?.after} />
            </div>
          ) : (
            /* 没有标签条时用一个弹性空位把右侧按钮推到行尾 */
            <div className="min-w-0 flex-1" />
          )}

          <ChromeSlot slot={slots?.actions} />

          <FrameControls
            items={chrome.moreItems}
            showMore={chrome.showMore}
            showMinimize={chrome.showMinimize}
            zone={zone}
            moreLabel={t('host.view.more')}
            collapseLabel={t('host.view.collapse')}
          />
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </section>
  )
}

/** 视图挂载在哪个工具区。'main' 与其他认不出的位置都返回 null */
function zoneOf(location: string | undefined): ZoneId | null {
  return location && isZoneId(location) ? location : null
}

/**
 * 标题栏左侧的标题。
 *
 * **不带图标**：图标位留给侧边按钮条（见 ToolStripe），而标题栏这一行要同时装下
 * 标签条与右端那两个按钮。工具区的宽度本来就紧，再放一个和按钮条重复的字形，代价
 * 是标题被截断得更早。
 */
function FrameTitle({ title }: { title: string }): JSX.Element {
  return (
    <div
      title={title}
      className="flex min-w-0 shrink-0 items-center pr-1 text-xs font-medium text-zinc-300"
    >
      <span className="max-w-40 truncate">{title}</span>
    </div>
  )
}

/** 标签条。样式与数据都交给 ViewTabStripView，这里只管下拉样式的展开状态 */
function TabStrip({
  chrome,
  slots
}: {
  chrome: ViewChromeConfig
  slots?: ViewChromeSlots
}): JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <ViewTabStripView
      variant={chrome.tabStrip}
      tabs={chrome.tabs}
      activeTabId={chrome.activeTabId}
      tabsClosable={chrome.tabsClosable}
      closeIcon={chrome.closeIcon}
      tabSlot={slots?.tabs?.tab}
      controller={chrome.controller}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      onCloseMenu={() => setOpen(false)}
    />
  )
}

/**
 * 标题栏右端的两个按钮：更多、最小化。
 *
 * 「更多」只在**确实有菜单项**时出现：一个点开是空面板的按钮比没有按钮更糟，
 * 而视图的菜单项是随状态变化的（选中了什么才有「重命名」），所以这个判断必须在
 * 渲染期做，不能只看静态声明。
 */
function FrameControls({
  items,
  showMore,
  showMinimize,
  zone,
  moreLabel,
  collapseLabel
}: {
  items: ViewMoreItem[]
  showMore: boolean
  showMinimize: boolean
  zone: ZoneId | null
  moreLabel: string
  collapseLabel: string
}): JSX.Element | null {
  const setVisible = useLayoutStore((s) => s.setVisible)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 点外面 / Esc 关闭。与 ContextMenu 同一套规则：mousedown 而不是 click，
  // 「按下别处就消失」不该等一次点击走完
  useEffect(() => {
    if (!open) return

    const onDown = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 只有工具区里的视图才有「收起」这回事：主编辑区没有可以关掉的容器
  const canMinimize = showMinimize && zone !== null
  const hasMore = showMore && items.length > 0

  if (!canMinimize && !hasMore) return null

  return (
    <div ref={rootRef} className="relative flex shrink-0 items-center gap-0.5 self-center">
      {hasMore && (
        <>
          <FrameIconButton
            icon="more"
            label={moreLabel}
            expanded={open}
            onClick={() => setOpen((value) => !value)}
          />
          {open && (
            <DropdownMenu
              className="absolute top-full right-0 z-50 mt-1"
              ariaLabel={moreLabel}
              items={toMenuItems(items, () => setOpen(false))}
            />
          )}
        </>
      )}

      {canMinimize && (
        <FrameIconButton
          icon="minimize"
          label={collapseLabel}
          onClick={() => {
            if (zone) setVisible(zone, false)
          }}
        />
      )}
    </div>
  )
}

/**
 * 外壳菜单项 -> 宿主菜单行。
 *
 * 两处加工：没有 `onSelect` 的条目（静态声明的那种）点一下就只关菜单；有动作的条目
 * 则**先关菜单再执行** —— 动作常常会切走视图，留着菜单只会让「菜单还在，而它指向的
 * 东西已经没了」这种状态出现。
 */
function toMenuItems(items: ViewMoreItem[], close: () => void): MenuItem[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    ...(item.icon ? { icon: item.icon } : {}),
    ...(item.disabled ? { disabled: true } : {}),
    ...(item.disabledReason ? { disabledReason: item.disabledReason } : {}),
    ...(item.danger ? { danger: true } : {}),
    onSelect: () => {
      close()
      item.onSelect?.()
    }
  }))
}

/** 标题栏上的小图标按钮。尺寸与标签条一致（h-6），整行才齐 */
function FrameIconButton({
  icon,
  label,
  expanded,
  onClick
}: {
  icon: string
  label: string
  expanded?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...(expanded === undefined ? {} : { 'aria-expanded': expanded })}
      onClick={onClick}
      className={[
        'flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors',
        expanded
          ? 'bg-zinc-700 text-zinc-100'
          : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
      ].join(' ')}
    >
      <BuiltinIcon name={icon} className="h-3.5 w-3.5" />
    </button>
  )
}
