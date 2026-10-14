/**
 * 菜单项的**类型**单独放在这一层。
 *
 * 它们本来定义在 `ui/MenuItem` 与 `ui/ContextMenu` 里，而那两个是组件模块：任何只
 * 想要这几个类型的模块一 import，模块图就会顺着组件链一路走到底
 * （ContextMenu -> MenuItem -> BuiltinIcon -> logger），于是「纯逻辑」不再纯 ——
 * 被测试拉进来时连 `window` 都用不了（见 tsconfig.node.json 的 include 说明，
 * 那里明确写着测试会覆盖渲染进程那一侧的纯逻辑）。
 *
 * 所以：**定义在这里**，组件模块 import 之后照原样 re-export 给各自的使用方。
 * 这一层没有任何运行时依赖，`import type` 出去什么都不会被求值。
 *
 * 渲染（图标位、置灰、danger 配色）仍然在 `ui/MenuItem`，不在这一层。
 */

/**
 * 菜单里的一行的内容。
 *
 * **左侧固定一个图标位**：没给图标时留一个等宽空位，而不是让文字顶到最左边 ——
 * 否则同一个菜单里「有图标」和「没图标」的行文字左边缘会差一格，看起来像两套对齐。
 * 图标名走宿主的图标集（见 layout/icons），与插件视图用的是同一批字形。
 */
export interface MenuItem {
  id: string
  label: string
  /**
   * 内置图标名。**可以省略**：省略就是空位（例如「从列表移除」这类没有合适字形的项）。
   * @see BUILTIN_ICONS
   */
  icon?: string
  onSelect: () => void
  /** 置灰 */
  disabled?: boolean
  /** 置灰时鼠标悬停给出的原因 */
  disabledReason?: string
  danger?: boolean
}

/**
 * 右键菜单里的一行。
 *
 * 与下拉菜单的项是**同一份**结构（`MenuItem`），别名只是为了让调用方的词汇对上：
 * `ContextMenu` 的使用方读到的名字里带 Context。
 */
export type ContextMenuItem = MenuItem

/**
 * 会展开子菜单的菜单项。
 *
 * 子菜单**只有一层**：再深一层就要开始处理「斜着移过去的路上经过别的行」这类问题，
 * 而右键菜单里的动作本来就不该多到需要两级以上。带子菜单的项没有 `onSelect` ——
 * 点它是展开，不是执行（见 SubmenuRow）。
 */
export interface ContextSubmenuItem {
  id: string
  label: string
  icon?: string
  items: ContextMenuItem[]
}

export type ContextMenuEntry = ContextMenuItem | ContextSubmenuItem
