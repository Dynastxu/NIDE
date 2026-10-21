import type { JSX } from 'react'
import type { HostMessageKey, Translator } from '@shared/i18n'
import type { PluginSettingsDescriptor } from '@shared/plugin-api'

/**
 * 设置页与设置树的登记表。
 *
 * 左边那棵树和右边的内容区都从这一份数据长出来。和最初版本的区别只有一处：
 * 树不再是**编译期常量** —— 插件通过 `contributes.settings` 贡献的页面在运行时
 * 合并进「插件」节点，所以这里导出的是 `buildSettingsTree()` 而不是
 * `SETTINGS_TREE`。
 *
 * ## 两条规则（没变）
 *
 * 1. **设置项可以任意嵌套，每一级都可点。** 有 `page` 的节点点开显示那个页面；
 *    没有的定义的显示**默认页** —— 一列指向它子设置的链接。
 * 2. **父节点不会被自己的页面吃掉子节点。** 有页面且还有子节点时，页面内容
 *    下面会再跟一组子设置链接，否则那些子节点就再也进不去了。
 */
export type HostSettingsPageId = 'language' | 'appearance' | 'plugins'

/**
 * 一个节点指向的页面。
 *
 * `host` 是宿主自己的页面，组件在 `SETTINGS_PAGES` 里静态登记；
 * `plugin` 是插件贡献的页面，组件由 `PluginSettingsSlot` 在构建期 glob 表里查。
 * 两者共用同一个 SettingsNode/pageProps 外壳，设置窗口不需要知道页面来自谁。
 */
export type SettingsPageRef =
  | { kind: 'host'; id: HostSettingsPageId }
  | { kind: 'plugin'; descriptor: PluginSettingsDescriptor }

export interface SettingsNode {
  id: string
  /** 已解析的文案。宿主节点由 t() 解析，插件节点由主进程按当前语言解析 */
  label: string
  /**
   * 这个节点自己对应的页面。**省略是合法的**：省略时点开显示默认页
   * （列出子设置的链接），而不是显示「未实现」。
   */
  page?: SettingsPageRef
  children?: SettingsNode[]
}

/** 宿主自己的树。插件设置页在 buildSettingsTree 里挂到 plugins 下 */
interface HostSettingsNode {
  id: string
  labelKey: HostMessageKey
  page?: HostSettingsPageId
  children?: HostSettingsNode[]
}

/**
 * 设置树。
 *
 * 根节点不出现在界面上（它只是个容器），所以这里直接列出顶层设置项。
 * 顶层项是**平级**的，嵌套只用在该分层的地方：语言属于通用，外观属于外观与行为，
 * 插件不属于任何东西 —— 插件是宿主的一等公民，不是"通用设置里的某一项"。
 *
 * 「外观与行为」自己**刻意没有页面**（和「通用」一样）：点它显示子设置入口。
 * 「外观」这一层则相反 —— 它就是一个页面，直接落在树上、不再多套一级。
 */
const HOST_SETTINGS_TREE: HostSettingsNode[] = [
  {
    id: 'general',
    labelKey: 'host.settings.page.general',
    // 刻意没有 page：宿主目前没有「通用设置」页面本身，点它显示子设置入口
    children: [
      { id: 'general.language', labelKey: 'host.settings.page.language', page: 'language' }
    ]
  },
  {
    id: 'appearance-behavior',
    labelKey: 'host.settings.page.appearanceBehavior',
    // 同样刻意没有 page：这一项是分组，点它显示「外观」这一个子设置
    children: [
      {
        id: 'appearance-behavior.appearance',
        labelKey: 'host.settings.page.appearance',
        page: 'appearance'
      }
    ]
  },
  { id: 'plugins', labelKey: 'host.settings.page.plugins', page: 'plugins' }
]

/**
 * 把宿主树与插件设置页合并成一棵可直接渲染的树。
 *
 * 纯函数：不读 IPC、不读 store，`t` 与插件描述都从参数来，方便单测。
 *
 * 插件页面挂在「插件」节点下，而不是另起一个顶层节点：插件设置属于插件，
 * 和「插件管理」是同一层的事。没有插件设置时「插件」保持叶子页，不画出空分组。
 */
export function buildSettingsTree(
  t: Translator,
  pluginSettings: PluginSettingsDescriptor[]
): SettingsNode[] {
  const tree = HOST_SETTINGS_TREE.map((node) => buildHostNode(node, t))
  if (pluginSettings.length === 0) return tree

  const pluginsNode = tree.find((node) => node.id === 'plugins')
  if (!pluginsNode) return tree

  pluginsNode.children = pluginSettings.map((descriptor) => ({
    // 插件 id 与设置 id 都自带点号，拼起来仍唯一；前缀避免和宿主节点撞名
    id: `plugin:${descriptor.pluginId}:${descriptor.id}`,
    label: descriptor.title,
    page: { kind: 'plugin', descriptor }
  }))

  return tree
}

function buildHostNode(node: HostSettingsNode, t: Translator): SettingsNode {
  return {
    id: node.id,
    label: t(node.labelKey),
    ...(node.page ? { page: { kind: 'host' as const, id: node.page } } : {}),
    ...(node.children ? { children: node.children.map((child) => buildHostNode(child, t)) } : {})
  }
}

/**
 * 宿主设置页的组件表。
 *
 * 用动态 import：设置窗口打开时不该为「以后可能点开的页面」付加载成本。
 * 插件页面不在这里 —— 它们由 PluginSettingsSlot 按 dir/entry 查 glob 表。
 */
export const SETTINGS_PAGES: Record<
  HostSettingsPageId,
  () => Promise<{ default: (props: SettingsPageProps) => JSX.Element }>
> = {
  language: () => import('@renderer/settings/pages/LanguagePage'),
  appearance: () => import('@renderer/settings/pages/AppearancePage'),
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
  /**
   * 把「提交草稿」和「丢弃草稿」两个动作注册上去，由底部按钮调用。
   *
   * 提交可以返回 `false` 表示“这次没成功，别关窗”——设置页的保存可能是异步的
   * （要落盘 / 系统加密），先关窗再等 IPC 会让用户看不到错误。返回 void 或 true
   * 都按成功处理，兼容同步页面。
   */
  registerActions: (
    commit: (() => boolean | void | Promise<boolean | void>) | null,
    reset: (() => void) | null
  ) => void
  /**
   * 报告「这次提交有没有改动到需要重启的插件」。
   *
   * 由页面在提交时调用一次：它比父级更清楚自己动了哪些插件，而父级不该去解析
   * 插件清单里那个 requiresRestart 字段 —— 那是插件页的知识。
   */
  onRestartRequired: () => void
}
