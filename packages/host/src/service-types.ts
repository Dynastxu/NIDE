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
import type { HostProjectStore } from '@nide/service-project/host-project-store.ts'
import type { ConfigService } from '@nide/service-config'
import type { SecretVault } from '@nide/contracts/secrets/index.ts'
import type { AiService } from '@nide/service-ai'
import type { HostAppearance } from '@nide/service-appearance/appearance.ts'
import type { I18nService } from '@nide/service-i18n'
import type { PluginManager } from '@nide/service-plugins/plugins.ts'
import type { PluginPermissionGuard } from '@nide/service-plugin-permissions/permissions.ts'
import type { PluginStorage } from '@nide/service-plugin-storage/storage.ts'
import type { PluginCapabilities } from '@nide/service-plugin-capabilities/capabilities.ts'
import type { PluginBackendRuntime } from '@nide/service-plugin-backend/runtime.ts'
import type { BuiltinViewRegistry } from '@nide/contracts/plugin-api/view.ts'

declare module 'cordis' {
  interface Context {
    /** 项目生命周期：列表 / 打开 / 移除 / 关闭 / 启动恢复 */
    project: HostProjectStore
    /** 项目配置：`.nide/config.yml` 与图鉴注册表的唯一实现 */
    config: ConfigService
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
    /** 内建视图登记表：业务包按域注册自己的视图 */
    builtinViews: BuiltinViewRegistry
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
