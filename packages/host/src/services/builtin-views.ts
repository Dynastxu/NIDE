import {
  HOST_COMMIT_VIEW_ID,
  HOST_EXPLORER_VIEW_ID,
  HOST_GIT_VIEW_ID,
  HOST_VIEW_PLUGIN_ID
} from '../../../../packages/contracts/src/plugin-api/view.ts'
import type {
  PluginViewDescriptor,
  ViewLocation
} from '../../../../packages/contracts/src/plugin-api/view.ts'
import type { zhCN } from '../../../../packages/contracts/src/i18n/locales/zh-CN.ts'

/**
 * 宿主词条表的 key 集合。
 *
 * 与 `@shared/i18n` 的 `HostMessageKey` 是同一个类型（那个模块为了兼容渲染进程
 * 用了免扩展名 import，host 的 NodeNext 解析不了，所以这里从词条表本身取）。
 */
type HostMessageKey = keyof typeof zhCN

/**
 * 宿主**内建**视图的登记表。
 *
 * 内建视图（文件树、版本控制、提交）和插件视图放在**同一张**视图表里，这样按钮条、
 * 工具区、「哪个区当前展示谁」这套已有机制原样复用 —— 内建视图不需要在布局层开
 * 第二条路。
 *
 * 和插件视图的差别只有两处：
 *
 * 1. 组件不在磁盘上，所以 `dir` / `entry` 是空串。渲染进程不会去 glob 它，
 *    而是按 `pluginId === HOST_VIEW_PLUGIN_ID` 交给宿主自己的组件表。
 * 2. 标题**不走 manifest 词条**（没有 manifest），直接由宿主词条表给出 key，
 *    查询时按当前语言解析 —— 和插件标题同一个解析器（`HostI18n.resolveTitle`），
 *    所以整张视图表只需要一次翻译。
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
  /** 宿主内置图标名（见 `packages/client-kit/src/icons.tsx`） */
  icon: string
}

export const HOST_VIEWS: readonly HostViewSpec[] = [
  {
    id: HOST_EXPLORER_VIEW_ID,
    titleKey: 'host.explorer.title',
    location: 'leftTop',
    icon: 'folder'
  },
  /**
   * 版本控制：页面在**底栏左半**（bottomLeft），按钮落在左侧按钮条**左下角**。
   *
   * 区的归属决定两个位置（见 ToolStripe 的 STRIPE_LAYOUT）：页面在底栏，而这一区的
   * 按钮被归入左侧按钮条的 `bottom` 分组，于是它出现在那条按钮条的最底部 ——
   * 不需要为「左下角那颗按钮」发明新的布局位。
   *
   * 底栏左半是**默认可见**的区（见 layout.store 的 initialZones），所以打开工作台就能
   * 看到这一页；左列上半部分仍然是文件树，两者不在同一块地方，互不遮挡。
   * 目前只有一行占位文案，没有接任何版本控制实现。
   */
  {
    id: HOST_GIT_VIEW_ID,
    titleKey: 'host.git.title',
    location: 'bottomLeft',
    icon: 'gitBranch'
  },
  /**
   * 提交：入口是标题栏的「文件 -> 提交」（见 renderer 的 MainMenu），不是按钮条上的按钮
   * —— 但它同时**也在**左上工具区的按钮条上，因为那个区的按钮条是按区里的视图列表画的
   * （文件树是第一个，所以这个区默认展示的仍然是文件树；见 HostSlot 的说明）。
   *
   * 之所以仍然登记成**视图**而不是菜单自己画一个浮层：切到某个区、由已有的工具区 + 插槽
   * 装配来渲染，这套机制已经在了，菜单只需要声明「切到谁」，页面本体不必再实现一遍。
   * 目前只有一行占位文案，点它不会提交任何东西。
   */
  {
    id: HOST_COMMIT_VIEW_ID,
    titleKey: 'host.commit.title',
    location: 'leftTop',
    icon: 'check'
  }
]

/**
 * 表格 → 视图描述符（`PluginViewDescriptor`），标题在这里解析。
 *
 * `message` 必须是**宿主词条表**的查询（`HostI18n.message`），不是插件 manifest 的
 * `%key%` 解析器：内建视图的 `titleKey` 是 `host.*`，交给后者会被当成普通字符串原样
 * 返回，界面上直接出现裸 key。
 *
 * 位置与调用点：host 的 `plugins.views` RPC 把它放在插件视图**前面** —— 排在前面的
 * 视图是各自区的第一个，也就是该区 `activeViewId` 为 null 时默认展示的那一个。
 */
export function builtinViews(message: (key: string) => string): PluginViewDescriptor[] {
  return HOST_VIEWS.map((view) => ({
    id: view.id,
    title: message(view.titleKey),
    location: view.location,
    icon: view.icon,
    pluginId: HOST_VIEW_PLUGIN_ID,
    // 内建视图的组件编译在壳里，没有插件目录，也没有入口文件
    dir: '',
    entry: ''
  }))
}
