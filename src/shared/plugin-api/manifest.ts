import type { LocaleContribution } from '@shared/i18n'
import type { ViewLocation } from './view'

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

  /** 激活事件：何时加载此插件。例如 "onStartup" */
  activationEvents?: string[]

  /** 权限声明：宿主据此拦截非法操作。例如 "fs:read", "fs:write", "network" */
  permissions?: string[]

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
     * 注册语言包。
     *
     * 语言包是**纯数据插件**：它不需要 UI 入口、不需要激活事件、也不需要权限，
     * 宿主只从它的目录里读一个 JSON 词条文件。之所以能这么轻，是因为宿主本来
     * 就不启动插件后端（见 plugin-host/loader.ts），语言包正好完全落在
     * 「主进程读盘 -> 作为纯数据下发渲染进程」这条既有链路上。
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
