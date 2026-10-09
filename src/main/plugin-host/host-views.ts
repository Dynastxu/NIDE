import { HOST_EXPLORER_VIEW_ID } from '@shared/plugin-api'
import type { HostMessageKey } from '@shared/i18n'
import type { ViewLocation } from '@shared/plugin-api'

/**
 * 宿主**内建**视图的登记表。
 *
 * 内建视图（目前只有文件树）和插件视图放在**同一张**视图表里，这样按钮条、工具区、
 * 「哪个区当前展示谁」这套已有机制原样复用 —— 内建视图不需要在布局层开第二条路。
 *
 * 和插件视图的差别只有两处：
 *
 * 1. 组件不在磁盘上，所以 `dir` / `entry` 是空串。渲染进程不会去 glob 它，
 *    而是按 `pluginId === HOST_VIEW_PLUGIN_ID` 交给宿主自己的组件表。
 * 2. 标题**不走 manifest 词条**（没有 manifest），直接由宿主词条表给出 key，
 *    查询时按当前语言解析（与插件标题同一时机，见 host.ipc.ts）。
 *
 * 这个表刻意写死在代码里而不是读配置文件：内建视图的组件是编译进宿主的，
 * 一个只存在于配置文件里的视图没有对应的组件，加载时必然失败。
 */
export interface HostViewSpec {
  id: string
  /**
   * 宿主词条表的 key。
   *
   * 类型是 HostMessageKey 而不是 string：内建视图的标题就在宿主词条表里，
   * 写错 key 应该是**编译错误**（和宿主代码里 t('host.xxx') 同一条保证）。
   */
  titleKey: HostMessageKey
  location: ViewLocation
  /** 宿主内置图标名（见 renderer 的 layout/icons.tsx） */
  icon: string
}

export const HOST_VIEWS: readonly HostViewSpec[] = [
  {
    id: HOST_EXPLORER_VIEW_ID,
    titleKey: 'host.explorer.title',
    location: 'leftTop',
    icon: 'folder'
  }
]
