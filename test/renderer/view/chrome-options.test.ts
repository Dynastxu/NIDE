import { describe, expect, it } from 'vitest'
import { DEFAULT_VIEW_CHROME } from '@shared/plugin-api'
import { buildChromeConfig, resolveChromeOptions } from '@renderer/view/chrome-options'

/**
 * 视图外壳开关的合并规则与默认值。
 *
 * 这里是「所有 ViewLocation 上的视图都默认有标题栏」这条约定的落点：默认值写错一个
 * 字段，界面上就是某个视图的标题栏或按钮凭空消失（或者一个什么都没声明的视图多出
 * 一个点了没反应的「更多」按钮）。所以默认值本身也要被断言，不能只测合并。
 *
 * 放在 test/renderer 而不是 test/shared/plugin-api：这一份断言的是**渲染进程那一侧**
 * 的合并逻辑（`@renderer/view/chrome-options`），只有默认值来自 shared。测试跟被测的
 * 东西走同一个编译单元 —— 跟着 shared 走的话，这个 import 在 IDE 的项目检查里会报
 * TS6307（见 tsconfig.node.json 与 tsconfig.web.json 的 include 划分）。
 */
describe('视图外壳的默认值', () => {
  it('全部开关默认打开', () => {
    expect(DEFAULT_VIEW_CHROME).toEqual({
      header: true,
      title: true,
      more: true,
      minimize: true,
      tabs: true
    })
  })

  it('一个什么都不声明的视图得到标题栏 + 标题 + 最小化按钮，没有标签条', () => {
    const chrome = buildChromeConfig(resolveChromeOptions(), '文件', undefined)

    expect(chrome.header).toBe(true)
    expect(chrome.showTitle).toBe(true)
    expect(chrome.showMinimize).toBe(true)
    // 没有标签页时标签条不占位（否则会白白多出一行高度）
    expect(chrome.showTabs).toBe(false)
    expect(chrome.tabs).toEqual([])
    // 默认**不可**关闭：标签页代表视图的一面，关掉它要视图显式打开
    expect(chrome.tabsClosable).toBe(false)
    expect(chrome.tabStrip).toBe('flat')
    expect(chrome.closeIcon).toBe('close')
  })

  it('「更多」按钮的显示由菜单项决定：没有条目就没按钮', () => {
    const bare = buildChromeConfig(resolveChromeOptions(), '文件', undefined)
    expect(bare.showMore).toBe(true)
    expect(bare.moreItems).toEqual([])

    const withMenu = buildChromeConfig(resolveChromeOptions(), '文件', {
      moreItems: [{ id: 'a', label: 'A' }]
    })
    expect(withMenu.moreItems).toHaveLength(1)
  })
})

describe('视图外壳开关的合并', () => {
  it('静态声明是默认值：运行期没提的项按声明走', () => {
    const options = resolveChromeOptions({ title: false, minimize: false, more: false })

    const chrome = buildChromeConfig(options, '文件', {
      // 只覆盖一项，其余留空
      configure: { showMinimize: true }
    })

    expect(chrome.showMinimize).toBe(true)
    expect(chrome.showTitle).toBe(false)
    expect(chrome.showMore).toBe(false)
  })

  it('运行期覆盖说了算，包括把静态声明的 false 打开', () => {
    // 静态声明是**默认值**而不是禁令：一份静态 JSON 说不出「只有在有内容时才画
    // 标题栏」这类条件，而视图的代码说得出（主编辑区的空态正是那样）
    const options = resolveChromeOptions({ header: false, title: false, tabs: false })

    const chrome = buildChromeConfig(options, '文件', {
      configure: { showHeader: true, showTitle: true, showTabs: true },
      tabs: [{ id: 'a', label: 'A' }]
    })

    expect(chrome.header).toBe(true)
    expect(chrome.showTitle).toBe(true)
    expect(chrome.showTabs).toBe(true)
  })

  it('标题取运行期那一份（视图可以把标题写成当前内容）', () => {
    const chrome = buildChromeConfig(resolveChromeOptions(), '视图名', { title: '第 3 章.md' })

    expect(chrome.title).toBe('第 3 章.md')
  })

  it('没有运行期标题时用视图描述里的标题', () => {
    expect(buildChromeConfig(resolveChromeOptions(), '文件', undefined).title).toBe('文件')
  })

  it('有标签页时标签条才占位', () => {
    const withoutTabs = buildChromeConfig(resolveChromeOptions(), '文件', { tabs: [] })
    const withTabs = buildChromeConfig(resolveChromeOptions(), '文件', {
      tabs: [{ id: 'a', label: 'A' }]
    })

    expect(withoutTabs.showTabs).toBe(false)
    expect(withTabs.showTabs).toBe(true)
  })

  it('tabs: false 的静态声明关掉标签条，即使有标签页', () => {
    const options = resolveChromeOptions({ tabs: false })

    const chrome = buildChromeConfig(options, '文件', { tabs: [{ id: 'a', label: 'A' }] })

    expect(chrome.showTabs).toBe(false)
    // 标签数据仍然带着：只是这一层不画，视图不必为了「现在不显示」把它删掉
    expect(chrome.tabs).toHaveLength(1)
  })

  it('header: false 的静态声明关掉整个标题栏（其余开关随之失去意义）', () => {
    const chrome = buildChromeConfig(resolveChromeOptions({ header: false }), '文件', {
      moreItems: [{ id: 'a', label: 'A' }]
    })

    expect(chrome.header).toBe(false)
  })

  it('运行期也能关掉标题栏：空态（编辑器一个文件都没打开）靠它整条不画', () => {
    const chrome = buildChromeConfig(resolveChromeOptions(), '编辑器', {
      configure: { showHeader: false, showTitle: false, showMinimize: false }
    })

    expect(chrome.header).toBe(false)
  })
})

/**
 * 两条真实调用点的取法，钉住「声明是默认值、运行期覆盖说了算」这条顺序。
 *
 * 这两个视图恰好各站一边：演示插件的视图完全按 manifest 走，文件视图则在运行期
 * 覆盖三项。任何一种合并顺序写反，都会在这两条里露出来。
 */
describe('真实视图的取法', () => {
  it('演示插件的视图：manifest 声明了不画标题与最小化，视图自己不提', () => {
    const options = resolveChromeOptions({ title: false, minimize: false })

    const chrome = buildChromeConfig(options, '右上示例', undefined)

    expect(chrome.showTitle).toBe(false)
    expect(chrome.showMinimize).toBe(false)
    // 没声明的项照旧：更多按钮允许，但菜单为空时仍然不画
    expect(chrome.showMore).toBe(true)
    expect(chrome.moreItems).toEqual([])
  })

  it('文件视图：运行期关掉标题与更多、打开下拉标签条，标题栏本身照旧', () => {
    const chrome = buildChromeConfig(resolveChromeOptions(), '文件', {
      tabs: [
        { id: 'projects', label: '项目' },
        { id: 'files', label: '文件' }
      ],
      activeTabId: 'files',
      controller: { selectTab: () => {}, closeTab: () => {} },
      configure: { showTitle: false, showMore: false, tabStrip: 'dropdown' }
    })

    expect(chrome.header).toBe(true)
    expect(chrome.showTitle).toBe(false)
    expect(chrome.showMore).toBe(false)
    expect(chrome.tabStrip).toBe('dropdown')
    expect(chrome.tabsClosable).toBe(false)
    expect(chrome.tabs).toHaveLength(2)
  })

  it('主编辑区：有文件时画标题栏，空态时整条不画', () => {
    const withFile = buildChromeConfig(resolveChromeOptions(), '编辑器', {
      tabs: [{ id: '/p/chapter_1.md', label: 'chapter_1.md' }],
      configure: { showHeader: true, showTitle: false, showMinimize: false }
    })
    const empty = buildChromeConfig(resolveChromeOptions(), '编辑器', {
      tabs: [],
      configure: { showHeader: false, showTitle: false, showMinimize: false }
    })

    expect(withFile.header).toBe(true)
    expect(withFile.showTabs).toBe(true)
    expect(empty.header).toBe(false)
  })
})
