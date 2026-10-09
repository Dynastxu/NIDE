import { JSX } from 'react'
import { useT } from '@renderer/stores/i18n.store'
import { useEditorStore, type EditorTab } from '@renderer/stores/editor.store'
import { BuiltinIcon } from '@renderer/ui/BuiltinIcon'
import { isMarkdownPath } from '@shared/project'

/**
 * 主编辑区顶部的标签页条。
 *
 * 只在有标签页时占位（一个文件都没打开时整条不渲染）—— 空的一条灰带子既没有
 * 信息，又占掉本来就不高的编辑区。
 *
 * 每个标签页上：
 * - 左边一个文件图标（Markdown 与纯文本用不同字形）；
 * - 中间文件名（截断，完整路径放 title）；
 * - 右边关闭按钮，**当前活跃的那个才常显**，其余悬停才显 —— 一排叉号会让
 *   文件名被迫缩短，而关标签页本来就是低频操作。
 *
 * 未保存的改动在文件名右侧显示一个圆点（见 TITLE_BAR 的说明：宿主没有实现保存，
 * 这个圆点只表示改动还没落盘）。
 */
export function EditorTabBar(): JSX.Element | null {
  const t = useT()
  const tabs = useEditorStore((s) => s.tabs)
  const activePath = useEditorStore((s) => s.activePath)
  const setActive = useEditorStore((s) => s.setActive)

  // 一个文件都没打开时整条不渲染：空条带是纯占地方
  if (tabs.length === 0) return null

  return (
    <div
      role="tablist"
      // 这条只服务于读屏软件：它读的是「一组标签页」，而不是「当前文件是什么」
      aria-label={t('host.editor.empty.title')}
      className="flex h-8 shrink-0 items-stretch overflow-x-auto border-b border-zinc-800 bg-zinc-950"
    >
      {tabs.map((tab) => (
        <EditorTabItem
          key={tab.path}
          tab={tab}
          active={tab.path === activePath}
          onSelect={() => setActive(tab.path)}
        />
      ))}
    </div>
  )
}

function EditorTabItem({
  tab,
  active,
  onSelect
}: {
  tab: EditorTab
  active: boolean
  onSelect: () => void
}): JSX.Element {
  const t = useT()
  const closeTab = useEditorStore((s) => s.closeTab)

  return (
    // 用 div + button 而不是把整块做成一个 button：里面还有关闭按钮，
    // 嵌套 button 是无效 HTML，键盘焦点也会变得莫名其妙
    <div
      className={[
        'group flex min-w-0 max-w-[220px] shrink-0 items-center gap-1.5 border-r border-zinc-800 border-t-2 pl-2.5 pr-1 text-xs',
        active
          ? // 活跃标签页：顶部一条高亮 + 与编辑区一致的底色，和其余标签页拉开层次
            'border-t-blue-500 bg-zinc-900 text-zinc-100'
          : 'border-t-transparent text-zinc-400 hover:bg-zinc-900/60'
      ].join(' ')}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        // 完整路径放 title：文件名会被截断，而这是唯一能分辨同名文件的地方
        title={tab.path}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
      >
        <BuiltinIcon
          name={isMarkdownPath(tab.path) ? 'file' : 'code'}
          className="h-3.5 w-3.5 shrink-0 opacity-70"
        />
        <span className="truncate">{tab.name}</span>
      </button>

      {tab.dirty && (
        // 圆点是「还没落盘」的唯一提示，所以它也要有可读的替代文本
        <span
          role="img"
          aria-label={t('host.editor.unsaved')}
          title={t('host.editor.unsaved.hint')}
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
        />
      )}

      <button
        type="button"
        aria-label={`${t('host.editor.tab.close')}: ${tab.name}`}
        title={t('host.editor.tab.close')}
        onClick={() => closeTab(tab.path)}
        className={[
          'flex h-4 w-4 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-700 hover:text-zinc-100',
          // 非活跃标签页的关闭按钮只在悬停时出现；用 opacity 而不是 hidden，
          // 这样它始终占位，鼠标划过时文件名不会左右跳
          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        ].join(' ')}
      >
        <BuiltinIcon name="close" className="h-3 w-3" />
      </button>
    </div>
  )
}
