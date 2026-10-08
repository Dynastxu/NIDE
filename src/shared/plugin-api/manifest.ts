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

  /** 贡献点：告诉宿主这个插件要往界面和系统里加什么 */
  contributes?: {
    /** 注册 UI 视图 */
    views?: PluginViewContribution[]
    /** 注册 Agent 可调用的工具 */
    tools?: PluginToolContribution[]
    /** 注册命令（快捷键/菜单项） */
    commands?: PluginCommandContribution[]
  }
}

export interface PluginViewContribution {
  /** 视图唯一 ID，例如 "demo.hello" */
  id: string
  /** 视图标题，例如 "AI 对话"。同时作为工具区按钮的 tooltip */
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
