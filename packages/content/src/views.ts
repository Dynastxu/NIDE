import type { zhCN } from '../../../packages/contracts/src/i18n/locales/zh-CN.ts'
import {
  HOST_EXPLORER_VIEW_ID,
  type BuiltinViewSpec
} from '../../../packages/contracts/src/plugin-api/view.ts'

/**
 * 宿主词条表的 key 集合。
 *
 * 和 plugin-runtime / git 一样从词条表本身取：`@nide/contracts/i18n` 那个入口为了
 * 兼容渲染进程用了免扩展名 import，host 的 NodeNext 解析不了。
 */
type HostMessageKey = keyof typeof zhCN

/**
 * 文件树的内建视图登记项。
 *
 * 视图组件在 `@nide/client-ui-explorer`（`view.host.explorer` slot）；宿主这边只登记
 * 位置 / 图标 / 词条 key。放在 content 服务里，是因为 `files.*` 这一域归它 ——
 * 谁拥有数据，谁登记它对应的视图。
 *
 * `order: 0`：左上工具区的第一个视图，区里 `activeViewId` 为空时默认展示它。
 */
export const EXPLORER_VIEW_SPEC = {
  id: HOST_EXPLORER_VIEW_ID,
  titleKey: 'host.explorer.title',
  location: 'leftTop',
  icon: 'folder',
  order: 0
} satisfies BuiltinViewSpec & { titleKey: HostMessageKey }
