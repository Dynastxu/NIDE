import path from 'node:path'
import type {
  PermissionVariables,
  PluginPermissions,
  ResolvedPermissions
} from '../../../../packages/contracts/src/plugin-api/permissions.ts'
import {
  allowsLegacy,
  isPathWithinScopes,
  resolvePermissions
} from '../../../../packages/contracts/src/plugin-api/permissions.ts'
import type { RpcRequest } from '../../../../packages/contracts/src/host-rpc/index.ts'
import type { RpcDenial } from '../../../kernel/src/rpc.ts'
import type { PluginManager } from './plugins.ts'

/**
 * 插件权限的**执行侧**（mics 的 PermissionsService 对应物）。
 *
 * 分工：
 * - `plugin-api/permissions.ts`：把清单里的声明解析 / 归一化（纯数据，渲染进程也能用）；
 * - 本文件：把「当前是谁在调、调什么、参数里的路径」翻译成一次准入判断。
 *
 * 只有 `trust: 'sandboxed'` 的插件会被限制：`full`（含一切老 manifest）与迁移前
 * 的行为完全一致，不会因为这次改动突然读不了项目文件。
 *
 * 检查范围：
 * - `fs.read` / `fs.write`：宿主 `files.*` / `gallery.*` / `overview.*` / `config.*`
 *   的路径参数必须落在展开后的作用域里；
 * - `net`：`ai.*` 要求声明过网络（`mode !== 'none'`）；
 * - 插件的安装 / 启停 / 卸载只对 `full` 开放；
 * - `os` / `exec` 目前没有对应的宿主 RPC（桌面能力还没以 `ctx.shell` 形式暴露给
 *   插件），只做校验与展示。
 *
 * 边界（不要当成硬沙箱宣传）：只有走 SDK `useHost().api` 的调用才带 `pluginId`；
 * 插件 bundle 与宿主 UI 同在一个渲染进程，直接摸 `window.hostAPI` 仍能绕过。
 * 这与 mics 对渲染进程插件的说明一致 —— 真正的强制隔离要等插件后端有独立进程。
 */

export type PermissionCapability = 'fs.read' | 'fs.write' | 'net' | 'manage'

const FS_READ: ReadonlySet<string> = new Set([
  'files.readDir',
  'files.readChapters',
  'files.readFile',
  'files.readForeshadowing',
  'gallery.read',
  'overview.read',
  'config.read'
])

const FS_WRITE: ReadonlySet<string> = new Set([
  'files.writeFile',
  'files.createEntry',
  'files.renameEntry',
  'files.deleteEntry',
  'gallery.create',
  'gallery.updateRegistry',
  'overview.setRole',
  'config.update',
  'config.initialize'
])

const NETWORK: ReadonlySet<string> = new Set([
  'ai.abort',
  'ai.list',
  'ai.open',
  'ai.remove',
  'ai.save',
  'ai.test'
])

/** 插件管理：安装 / 卸载 / 启停只对完全信任的插件开放 */
const MANAGEMENT: ReadonlySet<string> = new Set([
  'plugins.install',
  'plugins.remove',
  'plugins.rescan',
  'plugins.setEnabled'
])

export function capabilityOf(namespace: string, method: string): PermissionCapability | null {
  const key = `${namespace}.${method}`
  if (FS_READ.has(key)) return 'fs.read'
  if (FS_WRITE.has(key)) return 'fs.write'
  if (NETWORK.has(key)) return 'net'
  if (MANAGEMENT.has(key)) return 'manage'
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringAt(args: readonly unknown[], index: number): string[] {
  const value = args[index]
  return typeof value === 'string' && value.length > 0 ? [value] : []
}

function fieldOf(args: readonly unknown[], field: string): string[] {
  const record = asRecord(args[0])
  const value = record?.[field]
  return typeof value === 'string' && value.length > 0 ? [value] : []
}

/**
 * 一次调用涉及哪些真实路径（已解析成绝对路径）。
 *
 * 有些方法本身不带路径（`gallery.updateRegistry` 只收图鉴名、`overview.setRole`
 * 只收文件名）—— 它们的根由宿主按**当前项目配置**解析，所以这里用当前项目根兜底。
 * 拿不到路径时返回空数组，沙箱插件会被拒绝（宁可拒绝，也不猜）。
 */
export function pathsOf(
  namespace: string,
  method: string,
  args: readonly unknown[],
  projectRoot: string | undefined
): string[] {
  const key = `${namespace}.${method}`

  switch (key) {
    case 'files.readDir':
    case 'files.readFile':
    case 'files.readChapters':
    case 'files.readForeshadowing':
    case 'gallery.read':
    case 'overview.read':
    case 'config.initialize':
      return stringAt(args, 0)

    case 'files.writeFile':
      return fieldOf(args, 'filePath')

    case 'files.createEntry':
    case 'files.renameEntry':
    case 'files.deleteEntry':
    case 'gallery.create':
      return fieldOf(args, 'targetPath')

    // 这三个的根在项目配置里（图鉴目录 / 概述目录），调用方只给名字
    case 'gallery.updateRegistry':
    case 'overview.setRole':
    case 'config.read':
    case 'config.update':
      return projectRoot ? [projectRoot] : []

    default:
      return []
  }
}

export interface PluginPermissionGuardOptions {
  manager: PluginManager
  /**
   * 每次调用现取：项目根 / userData 会随窗口与设置变化。
   *
   * 必须按插件传 `pluginId` —— `${pluginDir}` 是**每个插件各不相同**的；
   * 不传的话这类作用域永远展开不出来，沙箱插件会被一律拒绝。
   */
  variables: (pluginId?: string) => PermissionVariables
  /** 当前项目的绝对路径；没开项目时 undefined */
  projectRoot: () => string | undefined
  /** 宿主所在平台是否大小写不敏感（Windows）；默认按 process.platform 判 */
  windows?: boolean
}

export interface PluginPermissionSnapshot {
  pluginId: string
  permissions: PluginPermissions
  resolved: ResolvedPermissions
}

export class PluginPermissionGuard {
  private readonly options: PluginPermissionGuardOptions
  private readonly windows: boolean

  constructor(options: PluginPermissionGuardOptions) {
    this.options = options
    this.windows = options.windows ?? process.platform === 'win32'
  }

  /** 某个插件的声明 + 展开结果（给设置页展示用） */
  snapshot(pluginId: string): PluginPermissionSnapshot | undefined {
    const permissions = this.options.manager.permissionsOf(pluginId)
    if (!permissions) return undefined

    return {
      pluginId,
      permissions,
      resolved: this.resolvedFor(pluginId) as ResolvedPermissions
    }
  }

  /** 老字符串语义：给宿主内部与插件 UI 的 `can()` 用 */
  allows(pluginId: string, legacy: string): boolean {
    const permissions = this.options.manager.permissionsOf(pluginId)
    if (!permissions) return false
    if (permissions.trust === 'full') return true
    return allowsLegacy(permissions, legacy)
  }

  /**
   * 展开后的作用域；未知插件返回 undefined。
   *
   * 插件后端子进程启动前用它算 `--allow-fs-*` 参数，所以必须是**按插件**展开的
   * （`${pluginDir}` 每个插件都不同）。
   */
  resolvedFor(pluginId: string): ResolvedPermissions | undefined {
    const permissions = this.options.manager.permissionsOf(pluginId)
    if (!permissions) return undefined
    return resolvePermissions(permissions, this.options.variables(pluginId))
  }

  /**
   * RPC 准入检查。没有 `caller.pluginId` 的调用（核心 UI / shell）一律放行。
   */
  authorize(request: RpcRequest): RpcDenial | null {
    const pluginId = request.caller?.pluginId
    if (!pluginId) return null

    const permissions = this.options.manager.permissionsOf(pluginId)
    if (!permissions) {
      return {
        code: 'unknown-plugin',
        message: `插件 ${pluginId} 不在清单里（可能已被卸载），本次调用被拒绝`
      }
    }
    if (permissions.trust === 'full') return null

    const capability = capabilityOf(request.namespace, request.method)
    if (!capability) return null

    if (capability === 'manage') {
      return {
        code: 'permission-denied',
        message: `插件 ${pluginId} 是受限权限，不能管理其它插件`
      }
    }

    if (capability === 'net') {
      if (!permissions.net || permissions.net.mode === 'none') {
        return {
          code: 'permission-denied',
          message: `插件 ${pluginId} 没有声明网络权限（permissions.net）`
        }
      }
      return null
    }

    const resolved = resolvePermissions(permissions, this.options.variables(pluginId))
    const scope = capability === 'fs.read' ? resolved.fs.read.resolved : resolved.fs.write.resolved
    const paths = pathsOf(
      request.namespace,
      request.method,
      request.args,
      this.options.projectRoot()
    )

    if (paths.length === 0) {
      return {
        code: 'permission-denied',
        message: `插件 ${pluginId} 的 ${request.namespace}.${request.method} 没有可判定的路径`
      }
    }

    const denied = paths.find((target) => !isPathWithinScopes(scope, target, this.windows))
    if (!denied) return null

    return {
      code: 'permission-denied',
      message: `插件 ${pluginId} 没有访问 ${path.normalize(denied)} 的${capability === 'fs.read' ? '读' : '写'}权限`
    }
  }
}
