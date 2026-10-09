import { Fragment, JSX, type MouseEvent } from 'react'
import { ViewIcon } from '@renderer/layout/ViewIcon'
import { useLayoutStore, type ZoneId } from '@renderer/stores/layout.store'
import { usePluginStore } from '@renderer/stores/plugin.store'
import { useT } from '@renderer/stores/i18n.store'
import type { PluginViewDescriptor } from '@shared/plugin-api'

/**
 * 两条侧边按钮条的编排：
 * - top 里的每个区依次成组，相邻两组之间画一条分割线
 * - bottom 里的区被弹性空隙推到按钮条最底部，正好和底栏同一水平线
 *
 * 一个区里注册了多个视图就是多个按钮（不再折叠成页签）。
 */
const STRIPE_LAYOUT: Record<'left' | 'right', { top: ZoneId[]; bottom: ZoneId[] }> = {
  left: { top: ['leftTop', 'leftBottom'], bottom: ['bottomLeft'] },
  right: { top: ['rightTop', 'rightBottom'], bottom: ['bottomRight'] }
}

/**
 * 侧边按钮条：整条常驻、贯穿整个窗口高度。
 * 工具区隐藏之后它是唯一的回程入口，一旦跟着隐藏就再也打不开了。
 *
 * 右键这条按钮条可以切换「标题显示在图标下面」——
 * 关掉就是纯图标窄条（36px），打开就是带标题的宽条（96px）。
 */
export function ToolStripe({ side }: { side: 'left' | 'right' }): JSX.Element {
  const views = usePluginStore((s) => s.views)
  const showTitles = useLayoutStore((s) => s.showStripeTitles)
  const setShowTitles = useLayoutStore((s) => s.setShowStripeTitles)
  const t = useT()
  const { top, bottom } = STRIPE_LAYOUT[side]

  // 没有视图的区不占位，也就不会多出一条孤零零的分割线
  const topZones = top.filter((id) => views.some((v) => v.location === id))
  const bottomZones = bottom.filter((id) => views.some((v) => v.location === id))

  const openMenu = (e: MouseEvent): void => {
    e.preventDefault()
    // 走主进程的原生菜单：渲染进程不关心菜单长什么样，
    // 只把「显示标题」的最新勾选值收回来。
    void window.hostAPI
      .showStripeMenu(showTitles)
      .then((next) => setShowTitles(next))
      .catch((err: unknown) => console.error('[nide] Open stripe menu failed:', err))
  }

  return (
    <aside
      onContextMenu={openMenu}
      title={t('host.stripe.tooltip')}
      className={[
        'flex shrink-0 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto bg-zinc-950 px-1 py-1',
        showTitles ? 'w-24' : 'w-9',
        side === 'left' ? 'border-r border-zinc-800' : 'border-l border-zinc-800'
      ].join(' ')}
    >
      {topZones.map((id, i) => (
        <Fragment key={id}>
          {i > 0 && <StripeDivider wide={showTitles} />}
          <ZoneGroup zoneId={id} showTitles={showTitles} />
        </Fragment>
      ))}

      <div className="min-h-0 flex-1" />

      {bottomZones.map((id, i) => (
        <Fragment key={id}>
          {i > 0 && <StripeDivider wide={showTitles} />}
          <ZoneGroup zoneId={id} showTitles={showTitles} />
        </Fragment>
      ))}
    </aside>
  )
}

/** 同一侧上下两组按钮之间的分割线 */
function StripeDivider({ wide }: { wide: boolean }): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={['my-1 h-px shrink-0 bg-zinc-700', wide ? 'w-full' : 'w-5'].join(' ')}
    />
  )
}

/** 一个区里的全部视图按钮，纵向排列 */
function ZoneGroup({
  zoneId,
  showTitles
}: {
  zoneId: ZoneId
  showTitles: boolean
}): JSX.Element | null {
  const views = usePluginStore((s) => s.views)
  const zoneViews = views.filter((v) => v.location === zoneId)

  if (zoneViews.length === 0) return null

  return (
    // w-full 是必须的：外层 aside 是 items-center，这个组默认会收缩成内容宽度，
    // 那样组内按钮的 w-full 就失去了参照，标题会被压成最窄。
    <div className="flex w-full shrink-0 flex-col items-center gap-1">
      {zoneViews.map((view, i) => (
        <StripeButton
          key={view.id}
          view={view}
          zoneId={zoneId}
          isFirst={i === 0}
          showTitles={showTitles}
        />
      ))}
    </div>
  )
}

interface StripeButtonProps {
  view: PluginViewDescriptor
  zoneId: ZoneId
  /** 该区第一个视图 —— activeViewId 为 null 时默认展示的就是它 */
  isFirst: boolean
  showTitles: boolean
}

function StripeButton({ view, zoneId, isFirst, showTitles }: StripeButtonProps): JSX.Element {
  const visible = useLayoutStore((s) => s.zones[zoneId].visible)
  const activeViewId = useLayoutStore((s) => s.zones[zoneId].activeViewId)
  const showView = useLayoutStore((s) => s.showView)
  const setVisible = useLayoutStore((s) => s.setVisible)

  const shown = visible && (activeViewId ? activeViewId === view.id : isFirst)

  return (
    <button
      type="button"
      aria-pressed={shown}
      aria-label={view.title}
      title={view.title}
      onClick={() => {
        // 再点一次已经展示中的按钮 = 收起这个区；点别的视图 = 切过去
        if (shown) setVisible(zoneId, false)
        else showView(zoneId, view.id)
      }}
      className={[
        'flex flex-col items-center justify-center rounded transition-colors',
        showTitles ? 'w-full gap-1 px-1 py-1.5' : 'h-7 w-7',
        shown ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
      ].join(' ')}
    >
      <ViewIcon view={view} />
      {showTitles && (
        <span className="w-full truncate text-center text-[11px] leading-tight">{view.title}</span>
      )}
    </button>
  )
}
