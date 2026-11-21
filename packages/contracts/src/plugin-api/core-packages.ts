/**
 * 「一切皆插件」之后的**核心包清单**。
 *
 * 设置里的「插件」页原本只列 `plugins/builtin/*`（用户能装、能禁用的那一类）。
 * 但改造之后，内核、宿主服务、客户端平台层、三个窗口包都是独立包 —— 它们不该混进
 * 可启停的插件列表（禁掉内核等于把应用关掉），却也不该完全看不见：用户/开发者排查
 * 「这功能在哪」时，这张表就是答案。
 *
 * 两个来源：
 * - `kind: 'service'`：**来自 profile**（`cordis.yml` 里 `core: true` 的行），所以
 *   宿主服务不用在这里再抄一遍，增删服务只改 profile；
 * - `kind: 'package'`：客户端的平台包（渲染进程的包，宿主看不到它们），只能静态列。
 *
 * `description` 是**开发者向**的中文说明（不是界面文案），不参与 i18n —— 这些条目
 * 只有排障时才看，翻成英文没有意义，反而要维护两份。
 */

export type CorePackageKind = 'service' | 'package'

export interface CorePackage {
  /** 稳定标识：服务用 profile 里的 id，包用包名（去掉 @nide/ 前缀） */
  id: string
  /** 显示名 */
  name: string
  kind: CorePackageKind
  /**
   * 模块位置：服务是 profile 里的路径，包是 `packages/<dir>`。
   * 只用于展示，宿主不会去读它。
   */
  path: string
  description: string
}

/**
 * 渲染进程的平台包（宿主看不到，静态列）。
 *
 * 加包 / 改名时同步这里 —— 它只影响设置里的展示，漏了不会坏功能，但会显得不完整。
 */
export const CORE_PACKAGES: readonly Omit<CorePackage, 'kind'>[] = [
  {
    id: 'contracts',
    name: '@nide/contracts',
    path: 'packages/contracts',
    description: '跨进程契约：类型、纯函数、词条基础表（无 Electron / DOM / IO）'
  },
  {
    id: 'kernel',
    name: '@nide/kernel',
    path: 'packages/kernel',
    description: '宿主内核：RPC 注册表、transport、ctx.shell 反桥、上下文扩展'
  },
  {
    id: 'boot',
    name: '@nide/boot',
    path: 'packages/boot',
    description: 'profile 解析与 Cordis 树启动（NIDE_HOME、模板升级）'
  },
  {
    id: 'host',
    name: '@nide/host',
    path: 'packages/host',
    description: '宿主装配入口：参数 → profile → 内核 → 服务 → transport'
  },
  {
    id: 'shell',
    name: '@nide/shell',
    path: 'packages/shell',
    description: 'Electron 外壳：窗口 / 菜单 / 对话框 / 日志 / nide-plugin 协议 / host 子进程'
  },
  {
    id: 'client-runtime',
    name: '@nide/client-runtime',
    path: 'packages/client-runtime',
    description: '客户端 Cordis 树：按各包声明的 windowTypes 装配窗口与 slot'
  },
  {
    id: 'client-kit',
    name: '@nide/client-kit',
    path: 'packages/client-kit',
    description: '客户端平台层：stores / ui 基础组件 / 窗口外壳 / logger / monaco / 文档状态'
  },
  {
    id: 'sdk',
    name: '@nide/sdk',
    path: 'packages/sdk',
    description: '插件开发者 API：useHost / 受限宿主 API / 插件词条上下文'
  },
  {
    id: 'client-modules',
    name: '@nide/client-modules',
    path: 'packages/client-modules',
    description: '插件浏览器半的模块表与 bundle 加载（dsviewId → 组件、nide-plugin://）'
  },
  {
    id: 'ui-renderer',
    name: '@nide/client-ui-renderer',
    path: 'packages/client-ui-renderer',
    description: '渲染管线：slot / 模块注册表的 React 绑定、PluginSlot、视图外壳 ViewFrame'
  },
  {
    id: 'ui-plugins',
    name: '@nide/client-ui-plugins',
    path: 'packages/client-ui-plugins',
    description: '插件管理界面（浏览 / 启停 / 卸载 / 重启提示）：设置与欢迎窗口共用'
  },
  {
    id: 'ui-main',
    name: '@nide/client-ui-main',
    path: 'packages/client-ui-main',
    description: '主窗口：布局 / 文件菜单 / 六个工具区与 main.editor / shell.overlay 的 slot'
  },
  {
    id: 'ui-editor',
    name: '@nide/client-ui-editor',
    path: 'packages/client-ui-editor',
    description: '编辑器功能包：中间编辑区 / diff 浮层 / editor.save 命令'
  },
  {
    id: 'ui-explorer',
    name: '@nide/client-ui-explorer',
    path: 'packages/client-ui-explorer',
    description:
      '文件树功能包：文件树 / 项目面板 / 条目动作，注册 view.host.explorer 与 shell.overlay'
  },
  {
    id: 'ui-git',
    name: '@nide/client-ui-git',
    path: 'packages/client-ui-git',
    description: '版本控制功能包：版本控制 / 提交视图的组件（注册到主窗口的 slot）'
  },
  {
    id: 'ui-welcome',
    name: '@nide/client-ui-welcome',
    path: 'packages/client-ui-welcome',
    description: '欢迎窗口：项目列表 + 插件页'
  },
  {
    id: 'ui-settings',
    name: '@nide/client-ui-settings',
    path: 'packages/client-ui-settings',
    description: '设置窗口：设置树 / 各设置页 / 插件设置页挂载点'
  }
]
