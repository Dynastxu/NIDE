import type { JSX } from 'react'
import type { HostMessageKey } from '@shared/i18n'

/**
 * 设置页与设置树的登记表。
 *
 * 左边那棵树和右边的内容区都从这一份数据长出来，所以「加一个设置页」= 在这里
 * 加一条页面登记 + 在树里挂一个节点，不需要同时改树、路由、菜单三处。
 *
 * ## 两条规则
 *
 * 1. **设置项可以任意嵌套，每一级都可点。** 有 `page` 的节点点开显示那个页面；
 *    没有的定义的显示**默认页** —— 一列指向它子设置的链接，点了跳过去。
 *    「通用」就是后者：它自己没有页面，点了显示「语言 / 插件」两个入口。
 * 2. **父节点不会被自己的页面吃掉子节点。** 有页面且还有子节点时，页面内容
 *    下面会再跟一组子设置链接（见 SettingsPageHost），否则那些子节点就再也
 *    进不去了 —— 它们只在树上可见，而树可以收起。
 */
export type SettingsPageId = 'language' | 'plugins'

export interface SettingsNode {
  id: string
  labelKey: HostMessageKey
  /**
   * 这个节点自己对应的页面。**省略是合法的**：省略时点开显示默认页
   * （列出子设置的链接），而不是显示「未实现」。
   */
  page?: SettingsPageId
  children?: SettingsNode[]
}

/**
 * 设置树。
 *
 * 根节点不出现在界面上（它只是个容器），所以这里直接列出顶层设置项。
 * 三个顶层项是**平级**的，嵌套只用在该分层的地方：语言属于通用，插件不属于
 * 任何东西 —— 插件是宿主的一等公民，不是"通用设置里的某一项"。
 */
export const SETTINGS_TREE: SettingsNode[] = [
  {
    id: 'general',
    labelKey: 'host.settings.page.general',
    // 刻意没有 page：宿主目前没有「通用设置」页面本身，点它显示子设置入口
    children: [
      { id: 'general.language', labelKey: 'host.settings.page.language', page: 'language' }
    ]
  },
  { id: 'plugins', labelKey: 'host.settings.page.plugins', page: 'plugins' }
]

/** 每页的标题词条，供页面体和默认页里的链接共用一份文案 */
export const PAGE_LABEL_KEYS: Record<SettingsPageId, HostMessageKey> = {
  language: 'host.settings.page.language',
  plugins: 'host.settings.page.plugins'
}

/**
 * 页面组件表。
 *
 * 用动态 import：插件设置页会拉起插件清单，而语言页只读一个 store。
 * 设置窗口打开时不该为「以后可能点开的页面」付加载成本。
 */
export const SETTINGS_PAGES: Record<
  SettingsPageId,
  () => Promise<{ default: (props: SettingsPageProps) => JSX.Element }>
> = {
  language: () => import('@renderer/settings/pages/LanguagePage'),
  plugins: () => import('@renderer/settings/pages/PluginsPage')
}

export interface SettingsPageProps {
  /**
   * 报告「有没有未应用的改动」。页面在本地维护草稿（改了先只动自己的 state），
   * 攒着等底部按钮决定命运 —— 这是「确定/取消/应用」这套按钮的语义前提。
   *
   * 不做成全局 store：草稿是**每个页面各自的形状**（这页是插件开关，那页可能是
   * 一堆输入框），塞进一个共享对象只会得到一堆 any。页面自己管，只把
   * 「脏不脏」这一个布尔量报上来。
   */
  onDirtyChange: (dirty: boolean) => void
  /**
   * 把「提交草稿」和「丢弃草稿」两个动作注册上去，由底部按钮调用。
   *
   * 为什么是回调而不是把草稿提到父级：草稿的形状只有页面自己知道。父级只负责
   * 在恰当的时机说「提交」或「丢弃」，不需要理解被提交的是什么。
   *
   * 传 null 表示这一页没有草稿概念（语言页就是），此时两个按钮对它都是空操作。
   */
  registerActions: (commit: (() => void) | null, reset: (() => void) | null) => void
  /**
   * 报告「这次提交有没有改动到需要重启的插件」。
   *
   * 由页面在提交时调用一次：它比父级更清楚自己动了哪些插件，而父级不该去解析
   * 插件清单里那个 requiresRestart 字段 —— 那是插件页的知识。
   */
  onRestartRequired: () => void
}
