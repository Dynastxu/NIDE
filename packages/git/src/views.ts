import type { zhCN } from '../../../packages/contracts/src/i18n/locales/zh-CN.ts'
import {
  HOST_COMMIT_VIEW_ID,
  HOST_GIT_VIEW_ID,
  type BuiltinViewSpec
} from '../../../packages/contracts/src/plugin-api/view.ts'

/**
 * 宿主词条表的 key 集合。
 *
 * 和 plugin-runtime 一样从词条表本身取：`@nide/contracts/i18n` 那个入口为了兼容
 * 渲染进程用了免扩展名 import，host 的 NodeNext 解析不了。
 */
type HostMessageKey = keyof typeof zhCN

/**
 * git 包贡献的内建视图。
 *
 * 只是**登记项**：视图组件在 `@nide/client-ui-git`，窗口按 id 渲染。顺序同样是视图表
 * 顺序 —— 版本控制在前、提交在后；两者都排在文件树之后（文件树由 plugin-runtime 先登记）。
 *
 * - 版本控制：页面在**底栏左半**（bottomLeft），按钮落在左侧按钮条**左下角**；
 * - 提交：入口是标题栏的「文件 -> 提交」，页面在左上工具区，所以也出现在该区按钮条上。
 *
 * 两个视图目前都只有占位页，没有任何仓库操作 —— 真正的 git 功能以后加在这个包里。
 */
export const GIT_VIEWS = [
  {
    id: HOST_GIT_VIEW_ID,
    titleKey: 'host.git.title',
    location: 'bottomLeft',
    icon: 'gitBranch',
    order: 10
  },
  {
    id: HOST_COMMIT_VIEW_ID,
    titleKey: 'host.commit.title',
    location: 'leftTop',
    icon: 'check',
    order: 20
  }
] satisfies readonly (BuiltinViewSpec & { titleKey: HostMessageKey })[]
