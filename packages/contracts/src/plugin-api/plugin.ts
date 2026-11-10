/**
 * 主进程 -> 渲染进程 传递的**插件**元信息（不是视图）。
 *
 * 和 PluginViewDescriptor 的分工：那个描述「界面上有哪些视图」，这个描述
 * 「装了哪些插件」。两者不是一回事 —— 纯数据插件（比如语言包）没有任何视图，
 * 却必须出现在「设置 -> 插件」的列表里。
 *
 * 同样只有数据：不带绝对路径、不带模块引用。渲染进程要显示目录名就够排查问题了，
 * 用户磁盘的完整布局不该越过 IPC。
 */
import type { PluginPermissions } from './permissions.js'

export interface PluginDescriptor {
  /** 插件唯一 ID，例如 'builtin.demo' */
  id: string
  /** 插件显示名称（manifest 的 name，**不是**本地化过的字符串） */
  name: string
  version: string
  /**
   * 内置还是第三方。
   *
   * 设置界面靠它决定「能不能卸载」：内置插件随宿主分发，删了下次启动又回来，
   * 所以不提供卸载入口 —— 这比让用户点了失败更诚实。
   */
  builtin: boolean
  /** 插件目录名，例如 'demo' / 'lang-en' */
  dir: string
  /** 声明过的权限，已按 manifest 归一化成 v2（老字符串数组会先展开）。 */
  permissions: PluginPermissions
  /**
   * 是否有主进程入口（manifest 的 `main`）。
   *
   * 有后端不等于「现在正在跑」——按 `activation` 懒启动的插件要等触发；
   * 实时状态问 `plugins.backends`。
   */
  hasBackend: boolean
  /** 是否有卸载脚本（manifest 的 `uninstall`） */
  hasUninstall: boolean
  /** 激活事件：`*` / `onStartup` / `onView:<id>` / `onCommand:<id>`；空 = 按需 */
  activation: string[]
  /** 依赖的插件 id；后端激活时先拉起依赖 */
  dependencies: string[]
  /** 内核级插件：不可通过界面禁用 */
  core: boolean
  /** 必需插件：不可通过界面禁用 */
  essential: boolean
  /** 实验性：界面可标注 */
  experimental: boolean
  /** 首次出现时默认禁用（用户显式启用后写进偏好） */
  defaultDisabled: boolean
  /** 这个插件贡献的视图 id 列表。纯数据插件（语言包）是空的 */
  views: string[]
  /**
   * 改动这个插件的启用状态后，是否需要重建窗口才能完全生效。
   *
   * 由**插件自己在 manifest 里声明**，宿主不猜：只有插件知道自己的东西是不是
   * 在启动时就被读进了某个不会再刷新的地方。语言包就是典型 —— 词条表在启动时
   * 被 host 构建成载荷、shell 缓存了一份，热改只会得到一份半新半旧的界面。
   */
  requiresRestart: boolean
  /** 插件自述。manifest 还没这个字段，当前一律为空 */
  description?: string
}

/**
 * 当前是否启用。
 *
 * 刻意**不并进 PluginDescriptor**：清单是「磁盘上有什么」，启用状态是「用户想
 * 让什么生效」，两者的来源和生命周期都不同（一个是扫描结果，一个是偏好）。
 * 合成一个对象就得在启用状态变化时伪造一份新清单。
 */
export type PluginEnabledMap = Record<string, boolean>

/**
 * 安装 / 卸载的失败原因。
 *
 * `cancelled` 只在 shell 侧出现（用户关掉了选择目录 / 卸载确认框），host 不会返回它。
 */
export type PluginMutationFailureReason =
  /** 目录里没有合法 manifest，或 manifest 被保留 id / 坏字段拒绝 */
  | 'invalid-plugin'
  /** 目标目录 / 插件 id 已经存在 */
  | 'already-exists'
  /** 内置插件随宿主分发，不能卸载 */
  | 'builtin'
  /** 清单里找不到这个 id */
  | 'not-found'
  /** 复制 / 删除 / 扫描失败 */
  | 'unreadable'
  /** 卸载脚本失败或超时（插件目录没有被删除） */
  | 'uninstall-failed'
  /** 用户取消了目录选择或卸载确认 */
  | 'cancelled'

export type PluginInstallResult =
  { ok: true; plugin: PluginDescriptor } | { ok: false; reason: PluginMutationFailureReason }

export type PluginRemoveResult =
  { ok: true; plugin: PluginDescriptor } | { ok: false; reason: PluginMutationFailureReason }
