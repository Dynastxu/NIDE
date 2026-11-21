import {
  HOST_VIEW_PLUGIN_ID,
  type BuiltinViewRegistry,
  type BuiltinViewSpec,
  type PluginViewDescriptor
} from '../../../packages/contracts/src/plugin-api/view.ts'
import type { zhCN } from '../../../packages/contracts/src/i18n/locales/zh-CN.ts'

/**
 * 宿主词条表的 key 集合。
 *
 * 与 `@nide/contracts/i18n` 的 `HostMessageKey` 是同一个类型（那个模块为了兼容渲染进程
 * 用了免扩展名 import，host 的 NodeNext 解析不了，所以这里从词条表本身取）。
 */
type HostMessageKey = keyof typeof zhCN

/**
 * 内建视图的**注册表**。
 *
 * 内建视图（文件树、版本控制、提交）和插件视图放在**同一张**视图表里，这样按钮条、
 * 工具区、「哪个区当前展示谁」这套已有机制原样复用 —— 内建视图不需要在布局层开
 * 第二条路。
 *
 * 表本身不再写死在这个包里：plugin-runtime 提供 `ctx.builtinViews`，各业务包在
 * `apply` 里登记自己负责的视图（`packages/content` 注册文件树，`packages/git` 注册
 * 版本控制 / 提交）。这里只保留注册表本身。
 *
 * 和插件视图的差别只有两处：
 *
 * 1. 组件不在磁盘上，所以 `dir` / `entry` 是空串。渲染进程不会去 glob 它，
 *    而是按 `pluginId === HOST_VIEW_PLUGIN_ID` 交给宿主自己的 slot（见
 *    `hostViewSlotName`）。
 * 2. 标题**不走 manifest 词条**（没有 manifest），直接由宿主词条表给出 key，
 *    查询时按当前语言解析 —— 和插件标题同一个解析器（`HostI18n.resolveTitle`），
 *    所以整张视图表只需要一次翻译。
 *
 * 视图的组件由客户端功能包按 id 注册到 slot；只登记描述符、没有组件时，渲染进程
 * 会显示「宿主没有实现内建视图」的说明页，而不是空白。
 */

/** `ctx.builtinViews` 的实现：按注册顺序保存，`list()` 按 `order` 排序。 */
export class HostBuiltinViews implements BuiltinViewRegistry {
  private readonly specs: BuiltinViewSpec[] = []

  register(spec: BuiltinViewSpec): () => void {
    this.specs.push(spec)
    return () => {
      const index = this.specs.indexOf(spec)
      if (index >= 0) this.specs.splice(index, 1)
    }
  }

  list(): readonly BuiltinViewSpec[] {
    return [...this.specs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }
}

/**
 * 登记项 → 视图描述符（`PluginViewDescriptor`），标题在这里解析。
 *
 * `message` 必须是**宿主词条表**的查询（`HostI18n.message`），不是插件 manifest 的
 * `%key%` 解析器：内建视图的 `titleKey` 是 `host.*`，交给后者会被当成普通字符串原样
 * 返回，界面上直接出现裸 key。
 *
 * 位置与调用点：host 的 `plugins.views` RPC 把它放在插件视图**前面** —— 排在前面的
 * 视图是各自区的第一个，也就是该区 `activeViewId` 为 null 时默认展示的那一个。
 */
export function toViewDescriptors(
  specs: readonly BuiltinViewSpec[],
  message: (key: string) => string
): PluginViewDescriptor[] {
  return specs.map((view) => ({
    id: view.id,
    title: message(view.titleKey),
    location: view.location,
    icon: view.icon,
    pluginId: HOST_VIEW_PLUGIN_ID,
    // 内建视图的组件由客户端功能包注册，没有插件目录，也没有入口文件
    dir: '',
    entry: ''
  }))
}
