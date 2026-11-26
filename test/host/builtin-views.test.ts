import { describe, expect, it } from 'vitest'
import {
  HostBuiltinViews,
  toViewDescriptors
} from '../../packages/plugin-runtime/src/builtin-views.ts'
import { EXPLORER_VIEW_SPEC } from '../../packages/content/src/views.ts'
import { GIT_VIEWS } from '../../packages/git/src/views.ts'
import {
  HOST_COMMIT_VIEW_ID,
  HOST_EXPLORER_VIEW_ID,
  HOST_GIT_VIEW_ID,
  HOST_VIEW_PLUGIN_ID
} from '../../packages/contracts/src/plugin-api/view.ts'

/**
 * 内建视图表（host 侧）。
 *
 * 视图表从「plugin-runtime 里写死」改成「plugin-runtime 提供注册表、业务包各自
 * 登记」之后，最容易出的错有三类：
 *
 * 1. 登记顺序错 —— 第一个视图是区的默认展示项（左上角必须是文件树）；现在顺序
 *    由 `order` 决定，不再依赖 Cordis 的 apply 顺序；
 * 2. 位置 / 图标 / 词条 key 手抄错 —— typecheck 看不出来，界面里只是少个按钮；
 * 3. 注册表本身又写死了视图 —— plugin-runtime 只该提供空表。
 *
 * 所以这里按真实的装配顺序（content 登记文件树、git 包登记两条）重建注册表，
 * 把三项都钉住。
 */
describe('builtin views', () => {
  // 宿主词条表的假查询：真实实现是 `HostI18n.message(key)`
  const resolve = (key: string): string => `zh:${key}`

  /** 按真实装配顺序重建注册表：content 的文件树 → git 包的两条 */
  function registry(): HostBuiltinViews {
    const builtin = new HostBuiltinViews()
    builtin.register(EXPLORER_VIEW_SPEC)
    for (const spec of GIT_VIEWS) builtin.register(spec)
    return builtin
  }

  it('空表：注册表本身不写死任何视图', () => {
    expect(new HostBuiltinViews().list()).toEqual([])
  })

  it('三条内建视图：文件树 / 版本控制 / 提交，按 order 排序', () => {
    expect(
      registry()
        .list()
        .map((view) => view.id)
    ).toEqual([HOST_EXPLORER_VIEW_ID, HOST_GIT_VIEW_ID, HOST_COMMIT_VIEW_ID])
  })

  it('注册顺序颠倒也不影响视图表顺序（order 决定）', () => {
    const builtin = new HostBuiltinViews()
    // 先登记 order 大的，再登记文件树：list() 仍须把文件树排在前面
    for (const spec of GIT_VIEWS) builtin.register(spec)
    builtin.register(EXPLORER_VIEW_SPEC)

    expect(builtin.list().map((view) => view.id)).toEqual([
      HOST_EXPLORER_VIEW_ID,
      HOST_GIT_VIEW_ID,
      HOST_COMMIT_VIEW_ID
    ])
  })

  it('位置与图标不能漂移（图标名对不上就画不出按钮）', () => {
    expect(
      toViewDescriptors(registry().list(), resolve).map(({ id, location, icon }) => ({
        id,
        location,
        icon
      }))
    ).toEqual([
      { id: HOST_EXPLORER_VIEW_ID, location: 'leftTop', icon: 'folder' },
      { id: HOST_GIT_VIEW_ID, location: 'bottomLeft', icon: 'gitBranch' },
      { id: HOST_COMMIT_VIEW_ID, location: 'leftTop', icon: 'check' }
    ])
  })

  it('标题走宿主词条表，pluginId 是 host，且没有插件目录 / 入口文件', () => {
    for (const view of toViewDescriptors(registry().list(), resolve)) {
      expect(view.pluginId).toBe(HOST_VIEW_PLUGIN_ID)
      // 传进去的 key 必须是 `host.*`，并且标题就是词条表给的值（不是 key 本身）
      expect(view.title.startsWith('zh:host.')).toBe(true)
      expect(view.dir).toBe('')
      expect(view.entry).toBe('')
    }
  })

  it('注销会从表里移除自己（服务卸载后不留幽灵视图）', () => {
    const builtin = registry()
    const dispose = builtin.register({
      id: 'host.temporary',
      titleKey: 'host.git.title',
      location: 'bottomRight',
      icon: 'check'
    })

    expect(builtin.list().map((view) => view.id)).toContain('host.temporary')
    dispose()
    expect(builtin.list().map((view) => view.id)).not.toContain('host.temporary')
  })
})
