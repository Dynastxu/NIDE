import { JSX } from 'react'
import { getBuiltinIcon } from '@renderer/layout/icons'
import { loggerFor } from '@renderer/logger'

const logger = loggerFor('ui')

/**
 * 内置图标的外壳：默认 16×16、描边继承文字颜色。
 *
 * 和 layout/ViewIcon.tsx 那层外壳形状相同，但**没有**合并成一个组件：那边接受
 * 插件声明的任意 SVG 字符串（要走 dangerouslySetInnerHTML），这里只吃内置图标名，
 * 两者共用的只有几个 SVG 属性，合并反而要把「内容从哪来」也变成参数。
 *
 * 尺寸走 className 而不是 size 参数：调用点常常还要一起调颜色 / 描边，
 * 传一整个 className 比发明第二套样式参数更直接。
 */
export function BuiltinIcon({
  name,
  className = 'h-4 w-4'
}: {
  name: string
  className?: string
}): JSX.Element {
  const inner = getBuiltinIcon(name)

  if (!inner) {
    // 图标名拼错时留一个等宽的占位，避免整行文字跳一下
    logger.warn('Unknown builtin icon, using a placeholder', { name })
    return <span aria-hidden="true" className={['shrink-0', className].join(' ')} />
  }

  return (
    <svg
      viewBox="0 0 24 24"
      className={['shrink-0', className].join(' ')}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {inner}
    </svg>
  )
}
