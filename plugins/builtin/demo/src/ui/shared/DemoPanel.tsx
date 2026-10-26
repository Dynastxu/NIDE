import { useState, type JSX } from 'react'
import { usePluginTranslator } from '@nide/client-kit/plugin-views/host-context'
import { useViewChrome } from '@nide/client-ui-main/view/chrome-context'
import { ViewFrame } from '@nide/client-ui-main/view/ViewFrame'
import { BuiltinIcon } from '@nide/client-kit/ui/BuiltinIcon'
import type { ViewChromeSlots, ViewMoreItem, ViewTab, ViewTabStrip } from '@shared/plugin-api'
import type { MessageTable } from '@shared/i18n'

/**
 * 这个演示插件**自己**维护词条表。
 *
 * 宿主只提供两样东西：当前是什么语言，以及 `{name}` 插值怎么做。
 * 文案数据归插件 —— 宿主既不知道别的插件有哪些文案，也维护不了。
 * 表里的第一个 key 约定为插件的默认语言，作为兜底。
 */
const MESSAGES: Record<string, MessageTable> = {
  'zh-CN': {
    clicked: '已点击 {count} 次',
    addTab: '新建标签页',
    closeTab: '关闭',
    renameTab: '重命名当前标签页',
    closeOthers: '关闭其他标签页',
    closeAll: '关闭全部标签页',
    tabName: '标签 {index}',
    empty: '没有标签页了，点标题栏右侧的加号新建一个。',
    body: '当前标签：{name}'
  },
  en: {
    clicked: 'Clicked {count} times',
    addTab: 'New tab',
    closeTab: 'Close',
    renameTab: 'Rename current tab',
    closeOthers: 'Close other tabs',
    closeAll: 'Close all tabs',
    tabName: 'Tab {index}',
    empty: 'No tabs left. Use the plus button on the right of the title bar.',
    body: 'Current tab: {name}'
  }
}

/**
 * 各分区示例视图共用的外壳 —— 同时也是**视图外壳 API 的活样例**。
 *
 * 它展示了视图能自己决定的三件事：
 *
 * 1. **标签页**：视图在自己的 state 里维护 `ViewTab[]`，交给宿主画成标题栏上的
 *    标签条（`tabStrip: 'flat'` 平展，`'dropdown'` 收成一个下拉）；
 * 2. **可关闭的标签**：`tabsClosable` 打开后，每个标签右侧出现关闭按钮，形状可以
 *    是叉号或圆点（这里用叉号；编辑器的未保存状态用的是圆点）；
 * 3. **自己的按钮**：`slots.tabs.after` 放了一个「新建标签页」的加号，
 *    `slots.actions` 放了一个与「更多」按钮并排的状态文字。
 *
 * 刻意**不画自己的标题栏**：标题、更多按钮、最小化按钮都由宿主画
 * （见 renderer 的 view/ViewFrame），视图正文里再重复一遍就是占地方。
 *
 * 放在 src/ui/shared/ 下也是刻意的：PluginSlot 的 import.meta.glob 只匹配
 * src/ui 目录下「一层」的 tsx 文件，glob 里的星号不跨目录分隔符，所以这个
 * 文件不会被当成插件视图入口，只能被同目录下的入口文件 import。
 */
export function DemoPanel({
  hint,
  tabStrip = 'flat'
}: {
  /** 显示在正文里的文件路径，便于对照是哪个视图 */
  hint: string
  /** 标签条样式。省略即平展 */
  tabStrip?: ViewTabStrip
}): JSX.Element {
  const t = usePluginTranslator(MESSAGES)
  const [count, setCount] = useState(0)
  const [seq, setSeq] = useState(2)
  const [tabs, setTabs] = useState<ViewTab[]>(() => [
    { id: 'tab-1', label: t('tabName', { index: 1 }), closable: true },
    { id: 'tab-2', label: t('tabName', { index: 2 }), closable: true }
  ])
  const [activeId, setActiveId] = useState<string>('tab-1')

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null

  const addTab = (): void => {
    const id = `tab-${seq + 1}`
    setSeq((value) => value + 1)
    setTabs((current) => [
      ...current,
      { id, label: t('tabName', { index: seq + 1 }), closable: true }
    ])
    setActiveId(id)
  }

  const closeTab = (id: string): void => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id)
      // 关掉的是当前这一个时，焦点交给右邻（没有就左邻）—— 与编辑器的标签页同一套规则
      if (id === activeId) {
        const index = current.findIndex((tab) => tab.id === id)
        setActiveId(next[index]?.id ?? next[index - 1]?.id ?? '')
      }
      return next
    })
  }

  /** 「更多」菜单的条目。没有标签时整条菜单为空，宿主随之不画「更多」按钮 */
  const moreItems: ViewMoreItem[] = tabs.length
    ? [
        { id: 'add', label: t('addTab'), icon: 'plus', onSelect: addTab },
        {
          id: 'rename',
          label: t('renameTab'),
          icon: 'rename',
          onSelect: () => {
            if (!active) return
            setTabs((current) =>
              current.map((tab) =>
                tab.id === active.id ? { ...tab, label: `${tab.label} *` } : tab
              )
            )
          }
        },
        {
          id: 'close-others',
          label: t('closeOthers'),
          disabled: tabs.length < 2,
          onSelect: () => setTabs((current) => current.filter((tab) => tab.id === activeId))
        },
        { id: 'close-all', label: t('closeAll'), danger: true, onSelect: () => setTabs([]) }
      ]
    : []

  /**
   * 把当前状态交给宿主的外壳，并挂上两个自己的按钮：标签条右端的「新建标签页」与
   * 「更多」按钮左侧的点击计数。`input` 每次渲染现算即可 —— 外壳只是一份普通对象，
   * 视图状态一变它自己就跟着变。
   */
  const chrome = useViewChrome({
    tabs,
    activeTabId: activeId,
    moreItems,
    controller: { selectTab: setActiveId, closeTab },
    configure: { tabStrip, tabsClosable: true, closeIcon: 'close' }
  })

  /** 两个自己的按钮：标签条右端的「新建标签页」与「更多」按钮左侧的点击计数 */
  const slots: ViewChromeSlots = {
    tabs: {
      after: (
        <button
          type="button"
          title={t('addTab')}
          aria-label={t('addTab')}
          onClick={addTab}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        >
          <BuiltinIcon name="plus" className="h-3.5 w-3.5" />
        </button>
      )
    },
    actions: (
      <span className="shrink-0 self-center pr-1 text-[11px] text-zinc-500">
        {t('clicked', { count })}
      </span>
    )
  }

  return (
    <ViewFrame chrome={chrome} slots={slots}>
      <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-3 text-zinc-300">
        <div className="min-h-0 shrink-0 font-mono text-[11px] leading-4 break-all text-zinc-500">
          {hint}
        </div>

        <p className="min-h-0 shrink-0 text-xs">
          {active ? t('body', { name: active.label }) : t('empty')}
        </p>

        {/* 外壳自己带了多少配置，这里就显示多少 —— 便于现场确认声明确实生效了 */}
        <pre className="min-h-0 shrink-0 overflow-auto rounded bg-zinc-900/60 p-2 font-mono text-[10px] leading-4 text-zinc-500">
          {`tabStrip=${chrome.tabStrip} tabs=${chrome.tabs.length} ` +
            `closable=${String(chrome.tabsClosable)} more=${String(
              chrome.showMore && chrome.moreItems.length > 0
            )}`}
        </pre>

        <button
          type="button"
          onClick={() => setCount((value) => value + 1)}
          className="mt-auto shrink-0 self-start rounded bg-zinc-800 px-2 py-1 text-[11px] hover:bg-zinc-700"
        >
          {t('clicked', { count })}
        </button>
      </div>
    </ViewFrame>
  )
}
