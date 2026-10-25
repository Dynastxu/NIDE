/**
 * 宿主自有能力的跨进程契约。
 *
 * 这里收的是**不属于任何具体业务域**的那些通道：窗口有 WINDOW_CHANNELS、项目有
 * PROJECT_CHANNELS、确认框有 CONFIRM_CHANNELS，而插件清单、词条表、主题、语言、
 * 事件总线这些既不是窗口能力也不是项目能力，是宿主本身的能力 —— 它们原先直接以
 * 字面量写在 main/ipc/host.ipc.ts 与 preload/index.ts 两处，现在收到这里。
 *
 * 这一层被主进程与预加载共用，所以**不能** import electron / DOM。
 */

/**
 * IPC 通道名。
 *
 * 和 WINDOW_CHANNELS 同理集中在这里：拼错通道名没有编译错误，只会在运行时静默
 * 失效。这一组尤其需要它 —— 每一条都在主进程和预加载里各写一遍，字面量复制出来
 * 的两份之间没有任何编译期关联，改一处漏一处的表现是 invoke 永不 resolve、
 * send 石沉大海，排查时看不到任何报错。
 */
export const HOST_CHANNELS = {
  // ============ 渲染进程 -> 宿主：invoke（要回执） ============

  /**
   * 界面上有哪些视图（宿主内建视图接在插件视图前面）。
   *
   * 渲染进程拿到的只是这份纯数据，组件怎么加载由渲染进程自己决定。manifest 的
   * 标题在**查询时**按当时语言解析，而不是扫描时 —— 扫描发生在 initI18n() 之前。
   */
  getPluginViews: 'host:get-plugin-views',
  /**
   * 全局设置里有哪些**插件贡献的设置页**。
   *
   * 和 getPluginViews 一样只返回纯数据（dir/entry 供渲染进程查构建期 glob 表）。
   * 标题按当前语言解析；被禁用插件贡献的设置页**不返回** —— 设置树里直接不显示，
   * 而不是显示一个点开就报错的页面。
   */
  getPluginSettings: 'host:get-plugin-settings',
  /** 取当前语言的词条表、可用语言列表和漏翻体检结果 */
  getI18n: 'host:get-i18n',
  /**
   * 装了哪些插件。
   *
   * 和 getPluginViews 是两件事：那个回答「界面上有哪些视图」，这个回答「磁盘上有
   * 哪些插件」。纯数据插件（语言包）只有后者认得。
   */
  getPlugins: 'host:get-plugins',
  /**
   * 已启用插件的浏览器半 bundle 清单（纯数据：pluginId / platform / 绝对路径）。
   *
   * 开发期绝对路径由渲染进程转成 Vite `/@fs/` URL；生产环境会换成 app 协议。
   */
  getClientBundles: 'host:get-client-bundles',
  /** 启用 / 禁用插件。禁用后它的视图从工具区消失，状态由宿主落盘 */
  setPluginEnabled: 'host:set-plugin-enabled',
  /** 当前被禁用的插件 id（宿主持久化过的那份） */
  getDisabledPlugins: 'host:get-disabled-plugins',
  /** 当前主题的完整载荷（可选哪些、现在用哪个、那个是深是浅） */
  getTheme: 'host:get-theme',
  /** 提交一套主题，参数只是一个主题 id；返回 false 表示这个主题不存在 */
  setTheme: 'host:set-theme',
  /** 请求切换语言。真正生效靠重建窗口，由主进程自己处理 */
  setLocale: 'host:set-locale',
  /** 工具区按钮条的右键菜单，返回「显示标题」的最新勾选状态 */
  showStripeMenu: 'host:show-stripe-menu',
  /** 插件重载（占位，等插件后端接上再实现） */
  reloadPlugin: 'host:reload-plugin',

  // ============ 渲染进程 -> 宿主：单向 send ============

  /**
   * 事件总线：渲染进程向宿主（或插件后端）发事件。
   *
   * 参数是 `(频道名, ...载荷)` —— 见 HOST_EVENT_CHANNELS 对「频道名」的说明。
   */
  eventEmit: 'host:event-emit',
  /**
   * 编辑器内容变化。
   *
   * 单向：这条消息**每次按键**都会来，不该让渲染进程为它 await 一个回执。
   */
  editorChange: 'host:editor-change',

  // ============ 宿主 -> 渲染进程：单向 send ============

  /**
   * 事件总线本身。
   *
   * 注意它是一条**独立的 Electron 事件名**，而它的第一个参数是总线上的**频道名**
   * （见 HOST_EVENT_CHANNELS）。两者不是一回事：`on(HOST_CHANNELS.event)` 收得到
   * 所有频道的事件，要靠频道名自己过滤。
   */
  event: 'host:event',
  /** 通知文件已变化，Monaco 据此刷新内容 */
  fileChanged: 'host:file-changed',
  /** 请求展示 Diff，由 Monaco Diff 组件消费 */
  showDiff: 'host:show-diff'
} as const

/**
 * 事件总线上的**频道名**（宿主 -> 渲染进程）。
 *
 * 和 APPEARANCE_CHANNEL 同理：这些字符串**不是**独立的 Electron 事件名，而是
 * `HOST_CHANNELS.event` 那条既有总线上的一个频道 —— 主进程
 * `send(HOST_CHANNELS.event, 频道名, 载荷)`，预加载收下来之后按这个字符串过滤。
 *
 * 之所以要集中：这个字符串的发送方在主进程、消费方在预加载，两边没有编译期关联，
 * 而它静默失效的样子是「界面上什么都不变」，属于最难查的一类。
 */
export const HOST_EVENT_CHANNELS = {
  /**
   * 插件启用状态变了。
   *
   * 必要性来自窗口模型：设置窗口和主窗口是两个渲染进程、各自持有一份 store，
   * 在设置窗口里取消勾选，主窗口那边不会自己变 —— 必须有人推它一把。
   */
  pluginEnabledChanged: 'plugin:enabled-changed'
} as const
