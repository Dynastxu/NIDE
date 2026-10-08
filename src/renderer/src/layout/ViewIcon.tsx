import { JSX, type ReactNode } from 'react'
import { ZoneIcon } from '@renderer/layout/ZoneIcon'
import { builtinIconNames, getBuiltinIcon } from '@renderer/layout/icons'
import { isZoneId } from '@renderer/stores/layout.store'
import type { PluginViewDescriptor } from '@shared/plugin-api'

/**
 * 工具区按钮的图标，取自视图自己声明的 `icon`。**只接受 SVG**，两种来源：
 *
 * 1. 自定义：`icon` 是一整段 SVG 字符串（含 '<'）。宿主只负责把尺寸压到 16×16，
 *    颜色和线宽由插件自己决定 —— 建议用 stroke='currentColor' 才能跟着按钮明暗。
 * 2. 内置：`icon` 只写图标名（见 icons.tsx 的 BUILTIN_ICONS），描边样式由宿主注入。
 *
 * 视图没声明 icon、或者名字拼错时回落到分区示意图，保证按钮不会变成空白。
 * 这条兜底路径本身也是 SVG —— 图标体系里不存在位图，也没有字体字形。
 */
export function ViewIcon({ view }: { view: PluginViewDescriptor }): JSX.Element {
  const spec = view.icon?.trim()
  const zone = isZoneId(view.location) ? view.location : null

  if (spec && spec.includes('<')) {
    return (
      <span
        aria-hidden="true"
        className="flex h-4 w-4 items-center justify-center [&_svg]:h-4 [&_svg]:w-4"
        dangerouslySetInnerHTML={{ __html: spec }}
      />
    )
  }

  if (spec) {
    const inner = getBuiltinIcon(spec)
    if (inner) return <BuiltinSvg>{inner}</BuiltinSvg>
    warnUnknownIcon(view.id, spec)
  }

  return zone ? <ZoneIcon zone={zone} /> : <BuiltinSvg>{getBuiltinIcon('panel')}</BuiltinSvg>
}

/** 内置图标统一的外壳：24×24 描边、颜色继承按钮的 text-* */
function BuiltinSvg({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** 同一个视图只告警一次，避免每帧刷屏 */
const warned = new Set<string>()

function warnUnknownIcon(viewId: string, spec: string): void {
  const key = `${viewId}:${spec}`
  if (warned.has(key)) return
  warned.add(key)

  console.warn(
    `[nide] 视图 ${viewId} 的 icon "${spec}" 既不是内置图标名，也不是一段 SVG（不含 '<'）。` +
      `已回落到默认图标。可用内置名：${builtinIconNames().join(', ')}`
  )
}
