import { JSX } from 'react'
import type { ZoneId } from '@renderer/stores/layout.store'

/**
 * 按钮图标：一张「工作台示意图」，外框是整窗，实心块是这块按钮负责的区域。
 * 项目里没有图标库，用内联 SVG 既零依赖，又能让 6 个按钮一眼区分开。
 *
 * viewBox 16×16；上部区 y 1.5~9.5，底栏 y 10.5~14.5。
 * 元组含义：[x, y, width, height]
 */
const REGION_RECTS: Record<ZoneId, [number, number, number, number]> = {
  leftTop: [1.5, 1.5, 4.5, 4],
  leftBottom: [1.5, 6, 4.5, 3.5],
  rightTop: [10, 1.5, 4.5, 4],
  rightBottom: [10, 6, 4.5, 3.5],
  bottomLeft: [1.5, 10.5, 6.5, 4],
  bottomRight: [8.5, 10.5, 6.5, 4]
}

export function ZoneIcon({ zone }: { zone: ZoneId }): JSX.Element {
  const [x, y, width, height] = REGION_RECTS[zone]

  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1">
      <rect x="0.5" y="0.5" width="15" height="15" rx="2" opacity="0.4" />
      <rect x={x} y={y} width={width} height={height} rx="1" fill="currentColor" stroke="none" />
    </svg>
  )
}
