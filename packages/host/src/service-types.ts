/**
 * Cordis 上下文的**服务 key 类型**（type-only）。
 *
 * 这些声明只做类型合并，运行时不产出任何东西。放在 host 侧是因为「哪些服务存在」
 * 是装配方的知识：服务包各自 `ctx.provide(...)`，但把它们拼到一个 `Context` 上的
 * 是 host。
 *
 * 消费方拿到类型的方式与 DSH 一致：`inject: ['project']` 之后直接 `ctx.project`。
 * 新增一个服务时，在对应服务包里 `ctx.provide(key, value)`，再在这里补一行类型。
 */
import type { HostProjectStore } from '../../services/project/src/host-project-store.ts'
import type { SecretVault } from '../../services/secrets/src/secrets.ts'
import type { AiService } from '../../services/ai/src/index.ts'
import type { HostAppearance } from '../../services/appearance/src/appearance.ts'
import type { I18nService } from '../../services/i18n/src/index.ts'
import type { PluginManager } from '../../services/plugins/src/plugins.ts'
import type { PluginPermissionGuard } from '../../services/plugins/src/permissions.ts'
import type { PluginStorage } from '../../services/plugins/src/storage.ts'
import type { PluginCapabilities } from '../../services/plugins/src/capabilities.ts'
import type { PluginBackendRuntime } from '../../services/plugins/src/backend/runtime.ts'

declare module 'cordis' {
  interface Context {
    /** 项目生命周期：列表 / 打开 / 移除 / 关闭 / 启动恢复 */
    project: HostProjectStore
    /** 密钥仓（没有 RPC） */
    secrets: SecretVault
    /** AI 供应商：宿主入口用它接上流式分片出口 */
    ai: AiService
    /** 主题 / 外观：偏好与主题解析 */
    appearance: HostAppearance
    /** 本地化：刷新语言包 / 解析标题 / 取词条 */
    i18n: I18nService
    /** 插件清单 / 启停 / 贡献点 */
    plugins: PluginManager
    /** 插件权限准入（RpcAuthorizer 的实现） */
    'plugin-permissions': PluginPermissionGuard
    /** 每插件命名空间的键值存储 */
    'plugin-storage': PluginStorage
    /** 受权限检查的桌面能力 */
    'plugin-capabilities': PluginCapabilities
    /** 插件后端子进程运行时 */
    'plugin-backend': PluginBackendRuntime
  }
}
