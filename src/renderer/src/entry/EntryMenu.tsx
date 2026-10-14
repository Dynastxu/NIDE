import { JSX } from 'react'
import { ContextMenu, type ContextMenuEntry } from '@renderer/ui/ContextMenu'
import { useT } from '@renderer/stores/i18n.store'
import { useExplorerStore } from '@renderer/stores/explorer.store'
import {
  openCreatePrompt,
  openRenamePrompt,
  requestDelete
} from '@renderer/stores/entry-action.store'
import { buildEntryMenu, withViewItems, type EntryActionTarget } from '@renderer/entry/entry-menu'

/**
 * 条目的右键菜单 —— **任何**列出项目条目的视图都用这一个。
 *
 * 视图只要报告两件事：右键的是谁、指针在哪里。剩下的（有哪些动作、哪些项该置灰、
 * 选中之后对话框怎么开）全在条目动作层，视图不再自己拼菜单项。
 *
 * ## viewItems 排在共用块**之前**
 *
 * 共用块的顺序是「新建 / 重命名 / 删除」，而删除是唯一不可撤销的一项，必须留在最后。
 * 所以视图自己的项只能加在前面 —— 追加在后面就会插到「删除」之后，把那条约定破坏掉。
 * 章节列表的「新建章节」正是这样加进来的。
 *
 * ## 需要**减少**共用项时
 *
 * 这个组件不提供「去掉某一项」的开关：现在没有任何一个面需要它。真的出现只读的面
 * （比如将来某个 diff 视图里的、磁盘上已经不存在的东西）时，那个视图应该直接调
 * `buildEntryMenu` 自己过滤再交给 `ContextMenu` —— 菜单项的动作是自包含的，绕过这
 * 一层不会丢掉任何行为。为还不存在的需求先摆一个开关，只会让这一层多一条没人走的路径。
 */
export function EntryMenu({
  x,
  y,
  target,
  viewItems,
  onClose
}: {
  x: number
  y: number
  /** 被右键的那个条目 */
  target: EntryActionTarget
  /** 视图自己的菜单项。**排在共用项之前**，见文件头 */
  viewItems?: ContextMenuEntry[]
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const roots = useExplorerStore((s) => s.roots)

  const items = buildEntryMenu(target, {
    roots,
    t,
    handlers: {
      create: openCreatePrompt,
      rename: openRenamePrompt,
      // 菜单项的 onSelect 是同步签名，而删除要等一次 IPC 与一次主进程的二次确认
      remove: (entry) => void requestDelete(entry)
    }
  })

  return <ContextMenu x={x} y={y} onClose={onClose} items={withViewItems(items, viewItems)} />
}
