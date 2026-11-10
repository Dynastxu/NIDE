/**
 * 宿主 ⇄ 插件后端子进程的协议。
 *
 * 只走 `fork` 的结构化克隆，不做 JSON 编解码 —— Buffer / Date / Map 能原样过界。
 * 这些类型**不跨渲染进程**，所以放在宿主包内，而不是 contracts。
 */
import type { PluginBackendPaths } from '../../../../contracts/src/plugin-api/backend.ts'

/** 子进程启动后收到的第一帧 */
export interface BootstrapMessage {
  t: 'bootstrap'
  pluginId: string
  /** 插件主进程入口的绝对路径 */
  entry: string
  paths: PluginBackendPaths
}

export interface InvokeMessage {
  t: 'invoke'
  id: number
  method: string
  params?: unknown
}

/** 卸载脚本：在插件停止之后、目录删除之前跑一次 */
export interface UninstallMessage {
  t: 'uninstall'
  pluginId: string
  entry: string
  paths: PluginBackendPaths
  storageFile: string
  storage: Record<string, unknown>
}

export type HostToWorker = BootstrapMessage | InvokeMessage | UninstallMessage | { t: 'dispose' }

export type WorkerToHost =
  | { t: 'ready'; methods: string[] }
  | { t: 'failed'; stage: 'import' | 'activate'; message: string }
  | { t: 'register'; method: string }
  | { t: 'unregister'; method: string }
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; error: string }
  | { t: 'uninstall-result'; ok: true }
  | { t: 'uninstall-result'; ok: false; error: string }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { t: 'disposed' }
