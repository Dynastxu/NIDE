import { describe, expect, it } from 'vitest'
import { builtinViews } from '../../packages/host/src/services/builtin-views.ts'
import {
  HOST_COMMIT_VIEW_ID,
  HOST_EXPLORER_VIEW_ID,
  HOST_GIT_VIEW_ID,
  HOST_VIEW_PLUGIN_ID
} from '../../src/shared/plugin-api/view.ts'

/**
 * 内建视图表（host 侧）。
 *
 * 这张表从 shell 搬进 host 时最容易出的错是「位置 / 图标 / 词条 key 手抄错」——
 * 它没有组件可对照，错了只是界面里少一个按钮或按钮跑到别的区，typecheck 看不出来。
 * 所以这里把三项都钉住，顺序也钉住（第一个视图是区的默认展示项）。
 */
describe('builtinViews', () => {
  const resolve = (pluginId: string, key: string): string => `${pluginId}:${key}`

  it('三张内建视图：文件树 / 版本控制 / 提交，顺序固定', () => {
    expect(builtinViews(resolve).map((view) => view.id)).toEqual([
      HOST_EXPLORER_VIEW_ID,
      HOST_GIT_VIEW_ID,
      HOST_COMMIT_VIEW_ID
    ])
  })

  it('位置与图标不能漂移（图标名对不上就画不出按钮）', () => {
    expect(builtinViews(resolve).map(({ id, location, icon }) => ({ id, location, icon }))).toEqual(
      [
        { id: HOST_EXPLORER_VIEW_ID, location: 'leftTop', icon: 'folder' },
        { id: HOST_GIT_VIEW_ID, location: 'bottomLeft', icon: 'gitBranch' },
        { id: HOST_COMMIT_VIEW_ID, location: 'leftTop', icon: 'check' }
      ]
    )
  })

  it('标题走宿主词条表，pluginId 是 host，且没有插件目录 / 入口文件', () => {
    for (const view of builtinViews(resolve)) {
      expect(view.pluginId).toBe(HOST_VIEW_PLUGIN_ID)
      expect(view.title.startsWith(`${HOST_VIEW_PLUGIN_ID}:host.`)).toBe(true)
      expect(view.dir).toBe('')
      expect(view.entry).toBe('')
    }
  })
})
