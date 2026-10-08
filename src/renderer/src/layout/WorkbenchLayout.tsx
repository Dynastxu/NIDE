import { JSX } from 'react'
import { MonacoDiffView } from '@renderer/editor/MonacoDiffView'
import { MonacoEditor } from '@renderer/editor/MonacoEditor'
import { Resizer } from '@renderer/layout/Resizer'
import { ToolStripe } from '@renderer/layout/ToolStripe'
import { ToolZone } from '@renderer/layout/ToolZone'
import { useZoneActive } from '@renderer/layout/zone-state'
import { useLayoutStore, type SizeKey, type ZoneId } from '@renderer/stores/layout.store'

/**
 * 工作台骨架（IDEA 式七分区）。
 *
 * ┌────┬─────────────┬──────────────┬─────────────┬────┐
 * │    │   左上       │              │   右上       │    │
 * │按钮├─────────────┤  中间主页     ├─────────────┤按钮│
 * │条  │   左下       │  MonacoEditor│   右下       │条  │
 * │    ├─────────────┴──────────────┴─────────────┤    │
 * │    │     底部左侧      │      底部右侧          │    │
 * └────┴───────────────────┴───────────────────────┴────┘
 *
 * 三条结构性规则：
 * 1) 两条按钮条是根部 flex-row 的第一个/最后一个子元素，**贯穿整个窗口高度**。
 *    底栏不能横跨整窗，否则会把按钮条截断在上面 —— 那正是「把按钮挤上去」。
 * 2) 底栏铺满两条按钮条之间的整个宽度：它和上部行同在中间那一列里，
 *    所以左右边界天然就是按钮条内缘。
 * 3) 左右两列是「上部行」的子元素，高度止于底栏顶边。所以侧边视图永远是从
 *    窗口顶部到底栏顶部，底栏一开一关它们就跟着伸缩。
 */
export function WorkbenchLayout(): JSX.Element {
  const leftWidth = useLayoutStore((s) => s.leftWidth)
  const rightWidth = useLayoutStore((s) => s.rightWidth)
  const bottomHeight = useLayoutStore((s) => s.bottomHeight)
  const bottomLeftWidth = useLayoutStore((s) => s.bottomLeftWidth)
  const grow = useLayoutStore((s) => s.grow)
  const resetSize = useLayoutStore((s) => s.resetSize)

  // 每个 hook 都必须无条件按同一顺序调用：写成 a() || b() 会因短路求值
  // 让 hook 数量随渲染变化，直接触发 React 的 hook 顺序错误。
  const leftTopOn = useZoneActive('leftTop')
  const leftBottomOn = useZoneActive('leftBottom')
  const rightTopOn = useZoneActive('rightTop')
  const rightBottomOn = useZoneActive('rightBottom')
  const bottomLeftOn = useZoneActive('bottomLeft')
  const bottomRightOn = useZoneActive('bottomRight')

  const leftColumnOn = leftTopOn || leftBottomOn
  const rightColumnOn = rightTopOn || rightBottomOn
  const bottomOn = bottomLeftOn || bottomRightOn

  /**
   * 尺寸用 h-full / w-full，**不要**改回 h-screen / w-screen。
   *
   * 这个组件从窗口骨架（WindowFrame）的内容区里长出来，而那条路上面还有一条
   * 32px 的标题栏。100vh 是**视口**高度、不看父容器，于是工作台会比它实际拿到
   * 的空间高出正好一个标题栏 —— 外层的 overflow-hidden 把多出来的那条裁掉，
   * 表现就是「左下角和右下角那两组按钮被截断」。
   *
   * 100% 则永远等于父容器给的尺寸，标题栏多高都不影响这里。
   */
  return (
    <div className="flex h-full w-full min-h-0 min-w-0 overflow-hidden bg-zinc-900 text-zinc-200">
      {/* 按钮条常驻且通高：工具区隐藏后它是唯一的回程入口，
          同时底栏也不会把它截断到半截高 */}
      <ToolStripe side="left" />

      {/* 按钮条之间的一切：上部行 + 底栏 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* ============ 上部行：左列 / 中间主页 / 右列 ============ */}
        <div className="flex min-h-0 flex-1">
          {leftColumnOn && (
            <>
              <div className="flex min-h-0 shrink-0 flex-col" style={{ width: leftWidth }}>
                <ToolColumn side="left" />
              </div>
              {/* 分隔条自带宽 1px 的边界线，相邻面板不要再加 border，否则是 2px */}
              <Resizer
                axis="x"
                onDelta={(d) => grow('leftWidth', d)}
                onReset={() => resetSize('leftWidth')}
              />
            </>
          )}

          {/* 中间主页：不可隐藏，永远吃掉剩余的全部空间 */}
          <div className="min-h-0 min-w-0 flex-1">
            <MonacoEditor />
          </div>

          {rightColumnOn && (
            <>
              <Resizer
                axis="x"
                onDelta={(d) => grow('rightWidth', -d)}
                onReset={() => resetSize('rightWidth')}
              />
              <div className="flex min-h-0 shrink-0 flex-col" style={{ width: rightWidth }}>
                <ToolColumn side="right" />
              </div>
            </>
          )}
        </div>

        {/* ============ 底栏：铺满两条按钮条之间的整个宽度 ============ */}
        {bottomOn && (
          <>
            {/* 这条分隔条自身就是边界线，底栏不要再加 border-t */}
            <Resizer
              axis="y"
              onDelta={(d) => grow('bottomHeight', -d)}
              onReset={() => resetSize('bottomHeight')}
            />
            <div className="flex min-h-0 w-full shrink-0" style={{ height: bottomHeight }}>
              {bottomLeftOn && (
                <>
                  {/* 右半块关掉时左半块自己撑满整行，否则右边会空出一大片 */}
                  <div
                    className={bottomRightOn ? 'min-h-0 shrink-0' : 'min-h-0 min-w-0 flex-1'}
                    style={bottomRightOn ? { width: bottomLeftWidth, maxWidth: '80%' } : undefined}
                  >
                    <ToolZone id="bottomLeft" />
                  </div>
                  {bottomRightOn && (
                    <Resizer
                      axis="x"
                      onDelta={(d) => grow('bottomLeftWidth', d)}
                      onReset={() => resetSize('bottomLeftWidth')}
                    />
                  )}
                </>
              )}
              {bottomRightOn && (
                <div className="min-h-0 min-w-0 flex-1">
                  <ToolZone id="bottomRight" />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <ToolStripe side="right" />

      <MonacoDiffView />
    </div>
  )
}

/** 左右列内部的上下切分。整列是否渲染由调用方的 leftColumnOn 决定。 */
function ToolColumn({ side }: { side: 'left' | 'right' }): JSX.Element | null {
  const topId: ZoneId = side === 'left' ? 'leftTop' : 'rightTop'
  const bottomId: ZoneId = side === 'left' ? 'leftBottom' : 'rightBottom'
  const heightKey: SizeKey = side === 'left' ? 'leftTopHeight' : 'rightTopHeight'

  const topOn = useZoneActive(topId)
  const bottomOn = useZoneActive(bottomId)
  const topHeight = useLayoutStore((s) => s[heightKey])
  const grow = useLayoutStore((s) => s.grow)
  const resetSize = useLayoutStore((s) => s.resetSize)

  // 只有一块可见时占满整列，并且不留分隔条：
  // 否则用户能把唯一可见的那块拖到 0 高，整个工具区就「消失」了。
  if (topOn && !bottomOn) return <ToolZone id={topId} />
  if (!topOn && bottomOn) return <ToolZone id={bottomId} />
  if (!topOn && !bottomOn) return null

  return (
    <>
      <div className="min-h-0 shrink-0" style={{ height: topHeight, maxHeight: '70%' }}>
        <ToolZone id={topId} />
      </div>
      <Resizer axis="y" onDelta={(d) => grow(heightKey, d)} onReset={() => resetSize(heightKey)} />
      <div className="min-h-0 flex-1">
        <ToolZone id={bottomId} />
      </div>
    </>
  )
}
