// host 也要用这里的类型：NodeNext 要求显式扩展名（`.js` 映射到 `.ts`），纯类型导入运行时会被擦除
import type { LocaleContribution } from '../i18n/types.js'
import type { ViewChromeOptions, ViewLocation } from './view.js'

export interface PluginManifest {
  /** 插件唯一标识，例如 "builtin.demo" */
  id: string
  /** 插件显示名称 */
  name: string
  /** 版本号 */
  version: string
  /**
   * 插件「后端」入口（相对于插件目录），例如 "dist/index.js"。
   * 当前阶段宿主不启动插件后端，可以先不提供。
   */
  main?: string

  /**
   * 插件「浏览器半」的运行时声明。
   *
   * 构建产物必须是 IIFE：加载时通过 `window.__NIDE_REGISTER__(viewId, Component)`
   * 把视图组件注册进客户端模块表。React / ReactDOM 由宿主以全局变量提供，
   * 插件 bundle 里不打包它们（见 scripts/build-plugin-client.mjs）。
   *
   * 只声明「有没有、在哪儿」，具体视图仍由 contributes.views 声明。
   */
  client?: {
    platform: 'web'
    /** 相对插件目录的 bundle 路径，例如 "dist/client.js" */
    bundle: string
  }

  /** 激活事件：何时加载此插件。例如 "onStartup" */
  activationEvents?: string[]

  /**
   * 权限声明：当前用于插件详情展示，以及宿主代理 API（secrets / storage 等）的
   * 准入判断。**它不是沙箱**：`network` / `fs` 这类能力不会被强制执行，插件
   * 后端（尚未实现）仍然握有完整 Node 权限。别把它当安全边界宣传。
   */
  permissions?: string[]

  /**
   * 这个插件依赖的其它插件 id。
   *
   * 当前只进了契约，**还没有**依赖解析或拓扑启动（插件后端尚未实现）。先放这个
   * 字段，是为了让 agent 插件以后能声明它依赖供应商插件，而不是靠硬编码 id 去猜。
   * 现阶段不要假设宿主会因为它拒绝加载插件。
   */
  dependencies?: string[]

  /**
   * 启用状态变化后是否需要重启宿主才能完全生效。
   *
   * 由插件自己声明，宿主**不猜**：只有插件知道自己的东西有没有落在某个
   * 「启动时读一次就不再刷新」的地方。宿主目前只对一件事硬编码了重启需求
   * （换语言），其余一律看这个字段。
   *
   * 省略即 false —— 绝大多数插件只是往工具区加个视图，禁用后视图消失就是
   * 立刻生效的。
   */
  requiresRestart?: boolean

  /** 贡献点：告诉宿主这个插件要往界面和系统里加什么 */
  contributes?: {
    /** 注册 UI 视图 */
    views?: PluginViewContribution[]
    /** 注册 Agent 可调用的工具 */
    tools?: PluginToolContribution[]
    /** 注册命令（快捷键/菜单项） */
    commands?: PluginCommandContribution[]
    /**
     * 注册全局设置里的子设置页。
     *
     * 只负责「页面挂在哪、入口文件是谁」：页面组件仍由渲染进程在构建期用
     * import.meta.glob 打包，和视图同一条链路。宿主不启动插件后端，所以设置页
     * 也只能是纯 UI。
     */
    settings?: PluginSettingsContribution[]
    /**
     * 注册语言包。
     *
     * 语言包是**纯数据插件**：它不需要 UI 入口、不需要激活事件、也不需要权限，
     * 宿主只从它的目录里读一个 JSON 词条文件。之所以能这么轻，是因为宿主本来
     * 就不启动插件后端（见 packages/host/src/services/plugin-contributions.ts），
     * 语言包正好完全落在「宿主读盘 -> 作为纯数据下发」这条既有链路上。
     *
     * 优先级：同一个 locale 被多个包提供时，**第三方覆盖内置**。
     */
    locales?: LocaleContribution[]
  }
}

export interface PluginViewContribution {
  /** 视图唯一 ID，例如 "demo.hello" */
  id: string
  /**
   * 视图标题，例如 "AI 对话"。同时作为工具区按钮的 tooltip。
   *
   * 两种写法，插件自己选：
   *
   * 1. **普通字符串** —— 直接显示，不做本地化。不想做 i18n 的插件保持原样即可。
   * 2. **`%key%` 占位符** —— 由插件**自己**的词条文件解析，宿主只负责按当前
   *    语言去查。文件名是约定（照抄 VS Code），不需要在 manifest 里声明：
   *
   *      package.nls.json           插件自己声明的默认语言，最后一档回落
   *      package.nls.<locale>.json  某个语言的翻译，例如 package.nls.en-US.json
   *
   *    解析链：精确 locale -> 放宽的 locale（en-US 命中 en）-> 默认表 -> 原样 `%key%`。
   *    最后一档刻意保留原样：漏翻会**显眼地**出现在界面上，而不是静默变空字符串
   *    或串到别的语言去。这和宿主自己 t() 的做法一致。
   *
   * 只有**整串**被 % 包住才算占位符，所以 "100% done" 这类标题是安全的。
   * 构建期 check:locales 会穷举校验每个 %key% 在每份词条文件里都存在。
   */
  title?: string
  /**
   * 工具区按钮的图标，由视图自己声明。**只接受 SVG**：
   *
   * - 自定义：一整段 SVG 字符串（含 '<'），例如
   *   "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor'><circle cx='12' cy='12' r='8'/></svg>"
   * - 内置：只写图标名，例如 "file" / "terminal" / "search" / "gitBranch"
   *
   * emoji、文字这类非 SVG 值会被当作未知图标名拒绝并回落到默认图标。
   */
  icon?: string
  /**
   * 挂载位置。
   *
   * 新契约是 6 个工具区 + 主编辑区：
   * leftTop / leftBottom / rightTop / rightBottom / bottomLeft / bottomRight / main。
   *
   * 'sidebar' / 'panel' 是旧契约，宿主会自动映射成 rightTop / bottomLeft，
   * 老插件不改 manifest 也能正常显示。
   */
  location?: ViewLocation | 'sidebar' | 'panel'
  /**
   * 视图外壳（标题栏）的静态开关：要不要标题栏、标题、更多按钮、最小化按钮、
   * 标签条。**全部默认打开**，所以省略它就得到最基本的那套外壳。
   *
   * 运行时那一半不在这里：标签列表、更多菜单的条目、标题栏里的按钮都由视图
   * 在渲染期自己给（`useViewChrome`），manifest 是启动时读一次的静态 JSON，
   * 装不下随状态变化的东西。
   */
  chrome?: ViewChromeOptions
  /**
   * UI 组件入口，**相对于插件目录**的 POSIX 路径，例如 "src/ui/index.tsx"。
   * 省略时默认为 "src/ui/index.tsx"。
   *
   * 只能是「插件目录内的相对路径」：主进程不会、也不能把绝对路径/磁盘位置传给渲染进程。
   * 渲染进程加载组件靠的是它自己构建期的 import.meta.glob 映射表。
   */
  entry?: string
}

export interface PluginToolContribution {
  /** 工具名称，供 AI 模型调用，例如 "read_file" */
  id: string
  /** 工具描述，告诉模型这个工具的作用 */
  description: string
  /** 参数 JSON Schema，方便模型生成正确的参数 */
  parameters: Record<string, unknown>
}

export interface PluginCommandContribution {
  id: string
  title: string
}

/**
 * manifest 里的一个设置页声明。
 *
 * `title` 和视图标题共用同一套 `%key%` 解析链：package.nls.json ->
 * package.nls.<locale>.json -> 原样占位符。解析发生在**查询时**、由 host 做
 * （扫描时还不知道当前语言；语言与词条表都在 host 手里）。
 */
export interface PluginSettingsContribution {
  /** 设置页唯一 ID，例如 "ai-provider.providers" */
  id: string
  /** 设置树与默认页里显示的标题，支持 %key% */
  title: string
  /**
   * 页面入口，**相对于插件目录**的 POSIX 路径。
   * 省略时为 "src/settings/index.tsx"。
   */
  entry?: string
  /** 同一父节点下的排序，小的在前；省略按标题排序 */
  order?: number
}

/**
 * 主进程 -> 渲染进程 传递的设置页元信息。
 *
 * 和 PluginViewDescriptor 一样只有数据：没有模块、没有函数、没有绝对路径。
 * 渲染进程拿 dir/entry 去查构建期生成的 glob 映射表。
 */
export interface PluginSettingsDescriptor {
  id: string
  pluginId: string
  /** 已按当前语言解析过的标题 */
  title: string
  dir: string
  entry: string
  order: number
}
