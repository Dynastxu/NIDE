/**
 * renderer ↔ host 的最小 RPC 契约。
 *
 * 这一层只放**纯数据**：没有 Electron、没有 DOM、没有 Node API。
 * 主进程、preload、renderer、host 共用同一份形状。
 *
 * 阶段 2 会把它升级成 DSH 式的 typed remote（按 namespace 生成类型、
 * 支持取消与流）；现在先用手写协议把链路跑通。
 */

export interface RpcRequest {
  type: 'rpc'
  id: string
  namespace: string
  method: string
  args: unknown[]
}

export interface RpcError {
  code: string
  message: string
  data?: unknown
}

export interface RpcSuccess {
  type: 'rpc-result'
  id: string
  ok: true
  result: unknown
}

export interface RpcFailure {
  type: 'rpc-result'
  id: string
  ok: false
  error: RpcError
}

export type RpcResponse = RpcSuccess | RpcFailure

/** 宿主 -> renderer 的推送事件（阶段 2 用）。 */
export interface HostEvent {
  type: 'event'
  namespace: string
  event: string
  payload: unknown
}

/** 主进程把 MessagePort 送给 renderer 时用的 channel 名。 */
export const HOST_PORT_CHANNEL = 'nide:host-port'

/**
 * host -> shell 的**反向**能力调用（D7 的 `ctx.shell` 雏形）。
 *
 * 方向很重要：正向 RPC 是 shell/renderer 调 host；这里反过来 —— host 里跑的业务
 * 需要 Electron 才有的东西（原生主题、`safeStorage` 加密）时，发一条调用请 shell
 * 执行。方法名是**白名单**：shell 只认下面这几个，host 拼不出任意 Electron API。
 */
export type ShellMethod =
  /** 设置原生主题（原生对话框 / 滚动条用），参数 'system' | 'light' | 'dark' */
  | 'nativeTheme.setSource'
  /** 系统当前是不是深色 */
  | 'nativeTheme.shouldUseDarkColors'
  /** `safeStorage` 可用吗（不可用时拒绝加解密） */
  | 'safeStorage.isAvailable'
  /** 明文 -> base64 密文 */
  | 'safeStorage.encrypt'
  /** base64 密文 -> 明文；解不开时抛错 */
  | 'safeStorage.decrypt'

export interface ShellCall {
  type: 'shell-call'
  id: string
  method: ShellMethod
  args: unknown[]
}

export type ShellCallResult =
  | { type: 'shell-result'; id: string; ok: true; result: unknown }
  | { type: 'shell-result'; id: string; ok: false; error: RpcError }

export function isShellCall(value: unknown): value is ShellCall {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { type?: unknown; id?: unknown; method?: unknown; args?: unknown }
  return (
    candidate.type === 'shell-call' &&
    typeof candidate.id === 'string' &&
    typeof candidate.method === 'string' &&
    Array.isArray(candidate.args)
  )
}

export function isShellCallResult(value: unknown): value is ShellCallResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { type?: unknown; id?: unknown; ok?: unknown }
  return (
    candidate.type === 'shell-result' &&
    typeof candidate.id === 'string' &&
    typeof candidate.ok === 'boolean'
  )
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { type?: string; id?: string; ok?: boolean }
  return (
    candidate.type === 'rpc-result' &&
    typeof candidate.id === 'string' &&
    typeof candidate.ok === 'boolean'
  )
}
