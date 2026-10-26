import { type JSX } from 'react'
import { useT } from '@nide/client-kit/stores/i18n.store'
import type { HostMessageKey } from '@nide/contracts/i18n'

/**
 * 宿主内建视图的**占位页**：整个视图只有一行文字。
 *
 * 用途是「位置已经定下来了，内容还没有」——版本控制与提交两个视图现在都是这个样子。
 * 视图名由侧边按钮条在图标下面显示，内容区里不再重复写一遍标题（与文件树同一条约定），
 * 所以这里只有那行说明。
 *
 * 做成一个共用组件而不是把同样的 JSX 抄两遍：抄出来的两份迟早会在样式上分叉。
 * 文案按**视图自己**的 key 取（见 shared/i18n 的宿主词条表），不在这里拼字符串。
 */
export function HostPlaceholder({ messageKey }: { messageKey: HostMessageKey }): JSX.Element {
  const t = useT()

  return <p className="p-3 text-xs text-zinc-500">{t(messageKey)}</p>
}
