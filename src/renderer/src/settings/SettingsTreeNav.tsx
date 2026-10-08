import { JSX, useState } from 'react'
import { useT } from '@renderer/stores/i18n.store'
import { SETTINGS_TREE, type SettingsNode } from '@renderer/settings/pages'

/**
 * 左侧设置选项树。
 *
 * 行为上像文件夹：
 * - 有子设置的节点前面有折叠箭头，点箭头收起 / 展开（**不**改选中项）
 * - 点标题选中该设置项 —— 父项和子项都能点，区别只在于父项往往没有自己的页面，
 *   那时右侧显示的是「子设置入口列表」（默认页）
 *
 * 用 ul/li + role="tree"：设置树的语义确实是树，屏幕阅读器能念出层级。
 * 不用 <details>：它的开合由浏览器管，没法做「选中项所在的父节点不能被收起」
 * 这类联动。
 */
export function SettingsTreeNav({
  selectedId,
  onSelect
}: {
  selectedId: string
  onSelect: (nodeId: string) => void
}): JSX.Element {
  const t = useT()
  /** 收起的节点 id。默认全展开 —— 设置项总共就那么几个，藏起来只会让人找不到 */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())

  const toggle = (nodeId: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }

  return (
    <nav
      aria-label={t('host.settings.nav.title')}
      className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-zinc-800 bg-zinc-950/40 py-2"
    >
      <ul role="tree" className="flex flex-col">
        {SETTINGS_TREE.map((node) => (
          <TreeItem
            key={node.id}
            node={node}
            depth={0}
            selectedId={selectedId}
            collapsed={collapsed}
            onSelect={onSelect}
            onToggle={toggle}
          />
        ))}
      </ul>

      {/* 树下面留白，不放东西：现在还没有「搜索设置项」，加了再说 */}
      <div className="min-h-0 flex-1" />
    </nav>
  )
}

function TreeItem({
  node,
  depth,
  selectedId,
  collapsed,
  onSelect,
  onToggle
}: {
  node: SettingsNode
  depth: number
  selectedId: string
  collapsed: ReadonlySet<string>
  onSelect: (nodeId: string) => void
  onToggle: (nodeId: string) => void
}): JSX.Element {
  const t = useT()
  const children = node.children ?? []
  const hasChildren = children.length > 0
  const isCollapsed = collapsed.has(node.id)
  const active = node.id === selectedId

  return (
    <li
      role="treeitem"
      aria-expanded={hasChildren ? !isCollapsed : undefined}
      aria-selected={active}
    >
      <div
        className={[
          'group mx-1.5 flex items-center rounded transition-colors',
          active ? 'bg-blue-600 text-white' : 'text-zinc-300 hover:bg-zinc-800'
        ].join(' ')}
      >
        {/* 折叠箭头。没有子设置时占一个等宽空位，让同级的标题左边缘对齐 */}
        {hasChildren ? (
          <button
            type="button"
            aria-label={t(
              isCollapsed ? 'host.settings.tree.expand' : 'host.settings.tree.collapse'
            )}
            onClick={() => onToggle(node.id)}
            className={[
              'flex h-6 w-5 shrink-0 items-center justify-center',
              active ? 'text-blue-100' : 'text-zinc-500 hover:text-zinc-300'
            ].join(' ')}
          >
            <Chevron open={!isCollapsed} />
          </button>
        ) : (
          <span aria-hidden="true" className="h-6 w-5 shrink-0" />
        )}

        {/* 标题本身就是选中按钮。整行可点（箭头除外），点空白处也算选中这一项 */}
        <button
          type="button"
          onClick={() => onSelect(node.id)}
          // 层级缩进：每深一级加 12px。刻意不缩进箭头所在的那一列，
          // 否则父子项的箭头会错开，看起来不像一棵树
          style={{ paddingLeft: depth * 12 }}
          className="min-w-0 flex-1 truncate py-1.5 pr-2 text-left text-xs"
        >
          {t(node.labelKey)}
        </button>
      </div>

      {hasChildren && !isCollapsed && (
        <ul role="group" className="flex flex-col">
          {children.map((child) => (
            <TreeItem
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              collapsed={collapsed}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

/** 折叠箭头。展开时朝下，收起时朝右 */
function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      className={['h-3 w-3 transition-transform', open ? 'rotate-90' : ''].join(' ')}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}
