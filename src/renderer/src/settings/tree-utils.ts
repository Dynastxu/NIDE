import type { SettingsNode } from '@renderer/settings/pages'

/**
 * 设置树的纯查询工具。
 *
 * 单独一个文件（而不是和 SettingsIndexPage 放一起）有两条理由：
 * - 那个文件导出组件，混着导出工具函数会让 react-refresh 的「只导出组件」
 *   检查失败 —— 热更新要么失效、要么整个模块重载；
 * - 这些函数是纯的、可单独测的，和渲染无关。
 */

/** 在一棵树里按 id 找节点（深度优先） */
export function findNode(nodes: SettingsNode[], id: string): SettingsNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const hit = node.children ? findNode(node.children, id) : null
    if (hit) return hit
  }
  return null
}

/**
 * 从根到目标节点的 id 路径（含目标）；找不到返回 null。
 *
 * 目前只有一处潜在用途（「展开到选中项」），但它是 findNode 的天然伙伴，
 * 放一起比散在两处好找。
 */
export function pathTo(nodes: SettingsNode[], id: string): string[] | null {
  for (const node of nodes) {
    if (node.id === id) return [node.id]
    if (!node.children) continue

    const sub = pathTo(node.children, id)
    if (sub) return [node.id, ...sub]
  }
  return null
}

/**
 * 树里第一个**真正有页面**的节点 id —— 设置窗口打开时的落点。
 *
 * 刻意跳过只有子设置的容器节点：容器点开是一列链接，作为首屏等于让人先看目录
 * 再点一下才能办事。落到第一个实际页面上更省一步。整棵树都没有页面时（理论上
 * 不该发生）回落到第一个节点，至少不空屏。
 */
export function firstPageNodeId(nodes: SettingsNode[]): string | null {
  for (const node of nodes) {
    if (node.page) return node.id
    if (node.children) {
      const hit = firstPageNodeId(node.children)
      if (hit) return hit
    }
  }
  return nodes[0]?.id ?? null
}
