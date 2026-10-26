import { JSX, type ReactNode } from 'react'
import { useT } from '@nide/client-kit/stores/i18n.store'
import { BuiltinIcon } from '@nide/client-kit/ui/BuiltinIcon'
import type {
  ViewChromeController,
  ViewSlotContent,
  ViewTab,
  ViewTabCloseIcon,
  ViewTabStrip
} from '@nide/contracts/plugin-api'

/** 一个槽位值在渲染进程里的真实类型：元素，或者按标签现算的函数 */
export type SlotContent = (tab: ViewTab) => ReactNode

/**
 * 标题栏里的标签条，两种样式：
 *
 * - `flat`：一行平展的标签页，溢出横向滚动（默认）；
 * - `dropdown`：收成一个下拉按钮，展开后是一列标签。
 *
 * 两者共用同一份 `tabs` 数据与同一套关闭按钮（`ViewTabCloseButton`），所以
 * 「标签上显示什么」「点它会怎样」只有一处定义 —— 换样式不会换出两套语义。
 */

export interface ViewTabStripProps {
  tabs: ViewTab[]
  activeTabId: string | null
  /** 标签默认能不能关（逐标签的 `closable` 优先） */
  tabsClosable: boolean
  /** 标签默认的关闭按钮形状 */
  closeIcon: ViewTabCloseIcon
  /** 单个标签内部、关闭按钮左侧的自定义按钮 */
  tabSlot?: ViewSlotContent
  controller: ViewChromeController
  /**
   * 下拉样式的展开状态由 Frame 持有：它的按钮长在标签条里，而「点外面关闭」的监听
   * 必须挂在整块标题栏上。所以这里只画，不管开关。
   */
  open?: boolean
  onToggle?: () => void
  onCloseMenu?: () => void
}

/** 按声明样式画标签条 */
export function ViewTabStripView({
  variant,
  ...props
}: ViewTabStripProps & { variant: ViewTabStrip }): JSX.Element {
  return variant === 'dropdown' ? <DropdownTabStrip {...props} /> : <FlatTabStrip {...props} />
}

/**
 * 平展标签条。
 *
 * 标签固定 24px 高并纵向居中：它和标题、按钮在同一行里，高度不一致整行看起来是斜的。
 */
function FlatTabStrip({
  tabs,
  activeTabId,
  tabsClosable,
  closeIcon,
  tabSlot,
  controller
}: ViewTabStripProps): JSX.Element {
  return (
    <div
      role="tablist"
      className="flex min-w-0 items-stretch gap-0.5 overflow-x-auto overflow-y-hidden"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId

        return (
          <div
            key={tab.id}
            className={[
              'group flex h-6 min-w-0 max-w-[200px] shrink-0 items-center gap-1 self-center rounded border-t-2 pr-0.5 pl-2 text-xs transition-colors',
              active
                ? 'border-t-blue-500 bg-zinc-800 text-zinc-100'
                : 'border-t-transparent text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200'
            ].join(' ')}
          >
            {/* div + button 而不是把整块做成 button：里面还有关闭按钮，嵌套 button 是无效 HTML */}
            <button
              type="button"
              role="tab"
              aria-selected={active}
              title={tab.title ?? tab.label}
              onClick={() => controller.selectTab(tab.id)}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left"
            >
              {tab.status === 'dot' && !closeShowsDot(tab, closeIcon, tabsClosable) && (
                <TabStatusDot />
              )}
              <span className="truncate">{tab.label}</span>
            </button>

            {/* 标签自己的按钮永远可见：它承载的是这个标签上的动作，藏起来就没有入口了 */}
            <TabButtonSlot slot={tabSlot} tab={tab} />

            <ViewTabCloseButton
              tab={tab}
              active={active}
              closable={tab.closable ?? tabsClosable}
              defaultIcon={closeIcon}
              onClose={() => controller.closeTab(tab.id)}
            />
          </div>
        )
      })}
    </div>
  )
}

/**
 * 下拉标签条。
 *
 * 与平展那一版的差别只有「标签列表什么时候可见」：一个是常驻的一行，一个是点开
 * 才出现的一列。当前项永远写在按钮上，所以收起状态不会丢掉「现在在哪一页」。
 */
function DropdownTabStrip({
  tabs,
  activeTabId,
  tabsClosable,
  closeIcon,
  tabSlot,
  controller,
  open = false,
  onToggle,
  onCloseMenu
}: ViewTabStripProps): JSX.Element {
  const t = useT()
  const active = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]

  return (
    <div className="relative flex min-w-0 shrink-0 items-center">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('host.view.tabs')}
        onClick={onToggle}
        className={[
          'flex h-6 min-w-0 max-w-[200px] items-center gap-1 rounded px-2 text-xs transition-colors',
          open ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800'
        ].join(' ')}
      >
        {active?.status === 'dot' && <TabStatusDot />}
        <span className="truncate">{active?.label ?? ''}</span>
        <BuiltinIcon name="chevronDown" className="h-3 w-3 opacity-70" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t('host.view.tabs')}
          className="absolute top-full left-0 z-50 mt-1 flex max-h-64 min-w-45 flex-col overflow-y-auto rounded-md border border-zinc-700 bg-zinc-800 py-1 shadow-xl shadow-black/40"
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId

            return (
              <div
                key={tab.id}
                className={[
                  'group flex items-center gap-1 pr-1 pl-2 text-xs',
                  isActive ? 'bg-blue-600/25 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-700'
                ].join(' ')}
              >
                <button
                  type="button"
                  role="menuitem"
                  aria-current={isActive}
                  title={tab.title ?? tab.label}
                  onClick={() => {
                    onCloseMenu?.()
                    controller.selectTab(tab.id)
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
                >
                  {/* 当前项占住图标位，与菜单里其他行对齐（见 MenuItem 的同一条约定） */}
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {isActive && <BuiltinIcon name="check" className="h-3.5 w-3.5" />}
                  </span>
                  {tab.status === 'dot' && !closeShowsDot(tab, closeIcon, tabsClosable) && (
                    <TabStatusDot />
                  )}
                  <span className="truncate">{tab.label}</span>
                </button>

                <TabButtonSlot slot={tabSlot} tab={tab} />

                <ViewTabCloseButton
                  tab={tab}
                  active={isActive}
                  closable={tab.closable ?? tabsClosable}
                  defaultIcon={closeIcon}
                  onClose={() => controller.closeTab(tab.id)}
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** 未保存一类的状态标识：标签文字左侧的圆点 */
function TabStatusDot(): JSX.Element {
  return <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
}

/**
 * 这个标签的关闭按钮会不会画成圆点。
 *
 * 两个调用点要用它做同一件事：**关闭按钮已经画了圆点时，标签文字左边那个状态圆点
 * 就不再画**。两者是同一个意思（「这个标签有没落盘的状态」），同一个标签上并排两个
 * 圆点只是把它说了两遍，而标签条本来就窄。留着关闭按钮那一格 —— 它离手更近，悬停
 * 时还会变成叉号，正好把「点它会丢掉这些改动」一起说出来。
 */
function closeShowsDot(
  tab: ViewTab,
  defaultIcon: ViewTabCloseIcon,
  tabsClosable: boolean
): boolean {
  if (!(tab.closable ?? tabsClosable)) return false

  return (tab.closeIcon ?? defaultIcon) === 'dot' && tab.status !== 'none'
}

/** 自定义标签按钮：给元素就固定画一个，给函数就按这个标签现算 */
function TabButtonSlot({
  slot,
  tab
}: {
  slot?: ViewSlotContent
  tab: ViewTab
}): JSX.Element | null {
  return <ChromeSlot slot={slot} tab={tab} />
}

/**
 * 标签页右侧那个按钮。
 *
 * 三种状态，都落在同一个位置上：
 *
 * - **不可关闭**：什么都不画。留一个空位也不行 —— 一排等宽的空隙看起来像坏掉的按钮；
 * - **可关闭 + `close`**：一个叉号。当前标签常显，其余悬停才显（一排叉号会让标签
 *   文字被迫缩短，而关标签本来就是低频操作）；
 * - **可关闭 + `dot`**：一个圆点。它承载的是视图自己的状态（文件没保存、有未读
 *   结果……），所以**常显**；鼠标悬停时才变成叉号 —— 状态与操作共用同一格宽度。
 *   常显由 `showDot` 那一格负责，也就是说**未选中的标签上它照样看得见**：圆点是状态，
 *   而状态不该等鼠标移上去才存在（叉号仍然是选中或悬停才画，理由同上一条）。
 */
export function ViewTabCloseButton({
  tab,
  active,
  closable,
  defaultIcon,
  onClose
}: {
  tab: ViewTab
  active: boolean
  closable: boolean
  defaultIcon: ViewTabCloseIcon
  onClose: () => void
}): JSX.Element | null {
  const t = useT()

  if (!closable) return null

  const icon = tab.closeIcon ?? defaultIcon
  const showDot = icon === 'dot' && tab.status !== 'none'
  const label = `${t('host.view.tab.close')}: ${tab.label}`

  return (
    <button
      type="button"
      aria-label={label}
      title={showDot ? t('host.view.tab.status') : label}
      onClick={(event) => {
        // 关标签不该顺带把整条标签选中一遍
        event.stopPropagation()
        onClose()
      }}
      className={[
        'flex h-4 w-4 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-700 hover:text-zinc-100',
        active || showDot
          ? 'opacity-100'
          : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
      ].join(' ')}
    >
      {showDot ? (
        <>
          {/* 圆点是状态，叉号是动作：悬停时换过去，位置不动 */}
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400 group-hover:hidden" />
          <BuiltinIcon name="close" className="hidden h-3 w-3 group-hover:block" />
        </>
      ) : (
        <BuiltinIcon name="close" className="h-3 w-3" />
      )}
    </button>
  )
}

/**
 * 一个自定义按钮槽位。
 *
 * 槽位值有两种写法：直接给一个元素（固定不变），或给一个函数（按当前标签现算）。
 * `unknown` 是 shared 那一层的类型（主进程也加载它，见 ViewSlotContent），到了这里
 * 它才被当成 ReactNode 用 —— React 的类型只属于渲染进程。
 */
export function ChromeSlot({
  slot,
  tab
}: {
  slot?: ViewSlotContent
  /** 需要按标签现算时给的那个标签 */
  tab?: ViewTab
}): JSX.Element | null {
  if (slot === null || slot === undefined || slot === false) return null

  if (typeof slot === 'function') {
    const computed = (slot as SlotContent)(tab as ViewTab)
    return computed === null || computed === undefined ? null : <>{computed}</>
  }

  return <>{slot as ReactNode}</>
}
