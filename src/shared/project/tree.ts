/**
 * 文件树的**行表构建**。
 *
 * 树在界面上不是用嵌套组件渲染的，而是先算成一张按显示顺序排好的行表（见
 * renderer 的 ExplorerView）。这么做的理由不是「少写一层组件」，而是每个节点都要
 * 知道自己是第几层、上面每一层的竖线画不画 —— 这两样都能从树的形状直接算出来，
 * 嵌套组件只能靠一层层传参数把它们传下去。
 *
 * 这个模块是**纯逻辑**：不碰 DOM、不碰 IPC、不认识词条表（要显示的文案由调用方以
 * 字符串传进来）。放在 shared 是因为它需要被单测 —— 而它埋进组件里的时候，正是
 * 「根目录一行子项都不显示」这种问题唯一会漏掉的地方。
 */

import { isInsideProject } from './files'
import type { DirReadFailureReason, FileTreeEntry } from './files'

/** 一张行表里的一行 */
export type TreeRow =
  | {
      kind: 'entry'
      /** React key。条目用路径（天然唯一） */
      key: string
      /** 缩进层级。0 是根 */
      depth: number
      entry: FileTreeEntry
      /**
       * 第 n 层那条竖线要不要画。
       *
       * 长度等于「这一行的祖先层数」，也就是 depth 减掉根那一层。竖线**要连到最后
       * 一个兄弟为止**：一个目录的最后一个子项之后再画线，就成了指向空白的一条线，
       * 而树里最容易看错的就是「这条线到底属于谁」。
       */
      guides: boolean[]
    }
  | {
      kind: 'note'
      key: string
      depth: number
      tone: 'muted' | 'error' | 'empty'
      text: string
    }

export interface TreeRowLabels {
  loading: string
  empty: string
  error: (reason: DirReadFailureReason) => string
}

/**
 * 「这个目录的子项该不该显示」。
 *
 * ## 为什么问的是目录，而不是节点
 *
 * 第一版把「可见」表达成**节点**路径的集合，渲染时查每个节点在不在里面。那个集合
 * 在没有「只看某一支」时只装了根目录 —— 于是根的子项一个都匹配不上，整棵树只剩根
 * 这一行（真实的 bug）。判据本身就问错了：被限定的从来不是「某个节点可不可见」，
 * 而是**这一支要不要往下走**。
 *
 * ## 语义
 *
 * - `pinned` 为空：**所有目录的子项都可见**（整棵项目树）。不预先算一份全集 ——
 *   那样又回到上面那个坑里去了。
 * - `pinned` 非空：只有被当作根的目录**及其子孙**的子项可见。祖先链上的目录自己
 *   会出现（否则被钉住的目录挂不到树上），但它们的**其它子项不展开** ——
 *   「只看这一支」的意思正在于此。
 *
 * 逐段比对（见 files 的 isInsideProject）：`D:\Novel2` 不会被当成 `D:\Novel` 之内。
 */
export function createChildVisibility(
  roots: string[],
  pinned: Record<string, true>
): (dirPath: string) => boolean {
  const pinnedPaths = Object.keys(pinned)
  const isPin = (target: string): boolean => pinnedPaths.includes(target)

  /** target 是某个 pin 的后代（pin 自己不算） */
  const isDescendantOfPin = (target: string): boolean =>
    pinnedPaths.some((pin) => pin !== target && isInsideProject(pin, target, true))

  /**
   * target 被**别人的** pin 盖住了（target 是那个 pin 的后代）。
   *
   * 只对「也是一个 pin 的目录」有影响：钉住「卷一」之后再钉「卷一\\第一节」，
   * 后者已经是前者的分支 —— 它不该再作为一个「根」单独出现，否则树里会多出一行
   * 已经在前者里面的目录。非 pin 的节点这一层不管（那是 isDescendantOfPin 的事）。
   */
  const hiddenByAncestorPin = (target: string): boolean => isDescendantOfPin(target)

  return (dirPath: string): boolean => {
    // 根永远可以展开：没有它就什么都看不到
    if (roots.some((root) => root === dirPath)) return true

    if (pinnedPaths.length === 0) return true

    // 被钉住的目录自己：被别人的 pin 盖住时让位，否则留着
    if (isPin(dirPath)) return !hiddenByAncestorPin(dirPath)

    // 祖先链上的目录要能走到被钉住的那一层，但**其余分支不展开**
    if (pinnedPaths.some((pin) => isInsideProject(dirPath, pin, true))) return true

    // 被钉住目录的子孙
    return isDescendantOfPin(dirPath)
  }
}

export interface BuildRowsInput {
  /** 树的根。**顺序即显示顺序**，通常是 [项目目录]（将来可能加上临时文件夹） */
  roots: string[]
  /** 已经读回来的目录内容。缺这个 key 表示还没读过 */
  children: Record<string, FileTreeEntry[]>
  errors: Record<string, DirReadFailureReason>
  loading: Record<string, boolean>
  expanded: Record<string, boolean>
  /**
   * 「这个**目录**的子项该不该显示」。
   *
   * 注意问的是目录，不是节点 —— 这个区别就是之前「根目录一行子项都不显示」的根因：
   * 那时传进来的是「可见**节点**的路径集合」，而在没有「只看某一支」时它只装了根
   * 目录，于是根的子项一个都不匹配。判据必须是「这一支要不要往下走」，而不是
   * 「这个节点在不在名单里」。
   */
  isChildVisible: (dirPath: string) => boolean
  labels: TreeRowLabels
}

/** 路径最后一段，作为根节点的显示名 */
export function treeBaseName(target: string): string {
  const segments = target.split(/[\\/]/).filter(Boolean)
  return segments.pop() ?? target
}

/**
 * 把树拍成一张按显示顺序排好的行表。
 *
 * 三种「说明行」（加载中 / 空目录 / 读失败）与条目行同在一张表里：它们在视觉上也
 * 是同一列里的一行，混在树的结构里反而要单独想「这一行挂在谁下面」。
 */
export function buildTreeRows(input: BuildRowsInput): TreeRow[] {
  const rows: TreeRow[] = []

  /**
   * 走一个目录。
   *
   * `guides` 是**父层**传下来的延续标记（第 n 项 = 第 n 层的祖先后面还有兄弟），
   * 每一层再把自己这一层的标记追加到末尾传给下一层。
   */
  const walk = (dirPath: string, depth: number, guides: boolean[]): void => {
    const entries = input.children[dirPath]
    const error = input.errors[dirPath]

    if (error) {
      rows.push({
        kind: 'note',
        key: `${dirPath}#error`,
        depth,
        tone: 'error',
        text: input.labels.error(error)
      })
      return
    }

    if (!entries) {
      // 没有条目 = 还没读过。正在读的给一行占位，否则什么都不显示
      if (input.loading[dirPath]) {
        rows.push({
          kind: 'note',
          key: `${dirPath}#loading`,
          depth,
          tone: 'muted',
          text: input.labels.loading
        })
      }
      return
    }

    if (entries.length === 0) {
      rows.push({
        kind: 'note',
        key: `${dirPath}#empty`,
        depth,
        tone: 'empty',
        text: input.labels.empty
      })
      return
    }

    /*
     * 两层判断，缺一层都不对：
     *
     * 1. **这个目录的子项该不该显示**（门）。为假时整片不渲染 —— 上一版把判据写成
     *    「每个节点在不在可见名单里」，而那个名单在没有只看某一支时只装了根目录，
     *    于是根的子项被整片挡掉（树上只剩根一行）。
     * 2. **每个条目自己要不要往下走**（筛）。为假时**这一条不出现**，它的子项也不会
     *    被递归到 —— 「只看某一支」挡的就是这种「旁边那一支」。
     *
     * 顺序也有讲究：先筛再算「谁在最后」，否则最后一个可见节点后面会留下一条指向
     * 空白的竖线。
     */
    const shown = input.isChildVisible(dirPath)
      ? entries.filter((entry) => input.isChildVisible(entry.path))
      : []

    shown.forEach((entry, index) => {
      const hasNext = index < shown.length - 1

      rows.push({ kind: 'entry', key: entry.path, depth, entry, guides: [...guides] })

      if (entry.kind !== 'directory') return
      if (!input.expanded[entry.path]) return

      walk(entry.path, depth + 1, [...guides, hasNext])
    })
  }

  for (const root of input.roots) {
    // 根自己就是树的顶：没有上层要连，所以 guides 为空
    rows.push({
      kind: 'entry',
      key: root,
      depth: 0,
      guides: [],
      // 根一定是个目录（它是项目目录或临时文件夹），名字从路径最后一段取
      entry: { kind: 'directory', path: root, name: treeBaseName(root) }
    })

    // 展开状态**缺失即展开**：根是树的门面，默认收起会让整棵树看起来是空的
    if (input.expanded[root] === false) continue
    walk(root, 1, [])
  }

  return rows
}
