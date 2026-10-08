import type { JSX, ReactNode } from 'react'

/**
 * 窗口标题栏上的图标。
 *
 * 刻意**不**并进 layout/icons.tsx 的 BUILTIN_ICONS：那张表是给**插件视图**选图标用的
 * （manifest 里写 `"icon": "file"`），把它扩成什么都能查的表，插件作者就会开始用
 * 「最小化」这种和视图无关的名字。这里的图标属于窗口骨架，不是插件契约的一部分。
 *
 * 约定沿用那张表：24×24、纯描边、不写死颜色，由外层注入 currentColor。
 *
 * 线宽取 2 而不是别处的 1.75，是为了和**使用尺寸**对上：这三个字形实现在 12px
 * （见 WindowControls），缩放正好 0.5 倍，2 × 0.5 = 1 个物理像素。1.75 会落成
 * 0.875px —— 在 1x 屏上是一条半亮的灰线，看起来就是「图标又小又虚」。
 */

interface IconProps {
  className?: string
}

function Stroke({ className, children }: IconProps & { children: ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** 最小化：一条横线 */
export function MinimizeIcon({ className }: IconProps): JSX.Element {
  return (
    <Stroke className={className}>
      <path d="M6 12h12" />
    </Stroke>
  )
}

/**
 * 最大化：一个方框。
 *
 * 描边**居中**在 12.5 而不是整数格上（`width=11` 起点也是 7）：线宽 1.5 需要
 * 落在半像素上，否则在 10px 尺寸下会一边重一边轻。
 */
export function MaximizeIcon({ className }: IconProps): JSX.Element {
  return (
    <Stroke className={className}>
      <rect x="7" y="7" width="11" height="11" rx="1" />
    </Stroke>
  )
}

/** 还原（已最大化时显示）：两个错开的方框 */
export function RestoreIcon({ className }: IconProps): JSX.Element {
  return (
    <Stroke className={className}>
      <rect x="6.5" y="8.5" width="9.5" height="9.5" rx="1" />
      <path d="M10 6.5h6a1.5 1.5 0 0 1 1.5 1.5v6" />
    </Stroke>
  )
}

/** 关闭：一个叉 */
export function CloseIcon({ className }: IconProps): JSX.Element {
  return (
    <Stroke className={className}>
      <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
    </Stroke>
  )
}
