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
  /** 声明过的权限，例如 ['fs:read']。详情页展示用，宿主早已按它做过拦截 */
  permissions: string[]
  /** 这个插件贡献的视图 id 列表。纯数据插件（语言包）是空的 */
  views: string[]
  /**
   * 改动这个插件的启用状态后，是否需要重建窗口才能完全生效。
   *
   * 由**插件自己在 manifest 里声明**，宿主不猜：只有插件知道自己的东西是不是
   * 在启动时就被读进了某个不会再刷新的地方。语言包就是典型 —— 词条表在
   * initI18n() 时构建成载荷并缓存在主进程里，热改只会得到一份半新半旧的界面。
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
