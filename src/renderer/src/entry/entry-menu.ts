import { filePathKey, type CreateEntryKind } from '@shared/project'
import type { Translator } from '@shared/i18n'
import type { ContextMenuEntry } from '@renderer/ui/menu-items'

/**
 * 条目动作集的**词汇**与共用菜单项的装配。
 *
 * 这一层不认识任何视图，也不碰任何 store：给它一个「被右键的条目」和一组处理器，
 * 它回一份菜单项。三件事因此各有各的位置，不会混在一起：
 *
 * - **动作集**（有哪些动作、对什么目标可用、为什么不可用）：这里；
 * - **动作的执行**（真的去建 / 改名 / 删）：`stores/entry-action.store.ts` 与它下面
 *   的 explorer store，落点推导与删除的二次确认在**主进程**；
 * - **呈现面**（这一次显示哪几项、排在哪）：调用方 —— 共用块之外由视图自己追加
 *   （见 `EntryMenu` 的 viewItems）。
 *
 * 写成纯函数是为了让「什么目标得到哪些项」可测：视图、zustand、i18n store 都不在
 * 这条依赖链上（见 test/renderer/entry-menu.test.ts）。所以处理器是**传进来的**，
 * 而不是这里 import 一个 store —— 与 shared/project 里 `sortTreeEntries` 收一个
 * collator 是同一条理由。
 */

/**
 * 一个可以被条目动作处理的目标。
 *
 * 刻意比 FileTreeEntry 窄：文件树里的条目、章节列表里的文件都满足它，而动作层
 * 需要的只有「路径、名字、是文件还是目录」这三样 —— 多要一个字段，就多一个
 * 让别的视图接不进来的理由。
 */
export interface EntryActionTarget {
  /** 绝对路径 */
  path: string
  /** 显示名（路径最后一段） */
  name: string
  kind: 'file' | 'directory'
}

/**
 * 新建的落点，只影响对话框标题里那句「建在哪儿」。
 *
 * 真正的落点由主进程从被右键的条目推导（目录 -> 内部，文件 -> 同级），这里这一份
 * 是为了在**问用户之前**就把话说对。
 */
export type CreateScope = 'inside' | 'sibling'

/** 菜单里选中一项之后真正要去做的三件事。由 EntryMenu 接到动作层 */
export interface EntryActionHandlers {
  create: (kind: CreateEntryKind, target: EntryActionTarget) => void
  rename: (target: EntryActionTarget) => void
  remove: (target: EntryActionTarget) => void
}

export interface EntryMenuContext {
  /**
   * 项目的根目录（可以不止一个）。
   *
   * 用途只有一个：判断「这一项能不能删」—— 根不能删。主进程在动作出口上还会再判
   * 一次（`is-project-root`），这里判是为了**在点之前就说清楚**：一个点了必然失败的
   * 菜单项，比一个置灰并写明原因的菜单项更糟。
   */
  roots: readonly string[]
  t: Translator
  handlers: EntryActionHandlers
  /**
   * 需要从共用块里排除的菜单项 ID。
   *
   * 与 viewItems（加项）互补 —— 有些面只需要一部分共用项，比如图鉴只关心图鉴自己
   * 的动作（新建条目 / 编辑字段 / 设为角色），不需要新建文件 / 重命名 / 删除这一类
   * 通用的文件操作。
   */
  exclude?: readonly string[]
}

/** 新建落点：右键目录 -> 建在它内部；右键文件 -> 建在它的同级 */
export function createScopeOf(target: EntryActionTarget): CreateScope {
  return target.kind === 'directory' ? 'inside' : 'sibling'
}

/**
 * 这个目标是不是项目的根目录。
 *
 * 大小写一律折叠：渲染进程里没有可靠的平台判断（理由见 shared/project 的
 * isInsideProject），而文件树自己算祖先链时也是这么折叠的（见 explorer.store 的
 * ancestorChain）。两处必须用同一种折叠方式，否则会出现「树认为它是根、菜单不认为」。
 */
export function isProjectRoot(target: EntryActionTarget, roots: readonly string[]): boolean {
  const key = filePathKey(target.path, true)
  return roots.some((root) => filePathKey(root, true) === key)
}

/**
 * 共用的条目菜单项。
 *
 * 顺序是定死的：新建 / 重命名 / 删除。「删除」留在最后并给 danger 配色 —— 它是这一列
 * 里唯一不可撤销的一项（没有回收站，也没有撤销），位置与颜色都要和另外两项拉开距离。
 *
 * 因此**视图自己的项必须排在整块之前**（见 `EntryMenu` 的 viewItems）：追加在后面就会
 * 插到「删除」之后，把那条「危险项在最后」的约定破坏掉。
 *
 * 适用性按**目标的状态**算，不按视图算：同一个目标在哪个视图里被右键，能做的事是
 * 一样的；视图之间真正的差别是「显示哪几项」，那由调用方决定。
 */
export function buildEntryMenu(
  target: EntryActionTarget,
  context: EntryMenuContext
): ContextMenuEntry[] {
  const { t, roots, handlers, exclude } = context
  const root = isProjectRoot(target, roots)

  const items: ContextMenuEntry[] = [
    {
      id: 'new',
      label: t('host.explorer.menu.new'),
      icon: 'plus',
      items: [
        {
          id: 'newFolder',
          label: t('host.explorer.menu.newFolder'),
          icon: 'folder',
          onSelect: () => handlers.create('directory', target)
        },
        {
          id: 'newFile',
          label: t('host.explorer.menu.newFile'),
          icon: 'file',
          onSelect: () => handlers.create('file', target)
        }
      ]
    },
    {
      id: 'rename',
      label: t('host.explorer.menu.rename'),
      icon: 'rename',
      onSelect: () => handlers.rename(target)
    },
    {
      id: 'delete',
      label: t('host.explorer.menu.delete'),
      icon: 'trash',
      danger: true,
      onSelect: () => handlers.remove(target),
      /*
       * 根不能删：主进程会以 is-project-root 拒绝（那等于把整个项目从磁盘上抹掉）。
       * 与其让用户点一次、过一次确认框、再收到一条失败提示，不如在这里就说清楚。
       */
      ...(root
        ? { disabled: true, disabledReason: t('host.explorer.delete.failed.is-project-root') }
        : {})
    }
  ]

  if (!exclude || exclude.length === 0) return items
  return items.filter((item) => !exclude.includes(item.id))
}

/**
 * 把视图自己的项接到共用块**前面**。
 *
 * 单独写成一个函数只为一件事：让「删除必须在最后」这条顺序约定可以被测
 * （见 test/renderer/entry-menu.test.ts）—— 顺序散在组件里就只能靠读代码确认，
 * 而它恰好是这一层唯一不能错的排版规则。
 */
export function withViewItems(
  items: ContextMenuEntry[],
  viewItems?: ContextMenuEntry[]
): ContextMenuEntry[] {
  if (!viewItems || viewItems.length === 0) return items
  return [...viewItems, ...items]
}
