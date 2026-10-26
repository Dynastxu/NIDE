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
  /** 系统安全存储能用吗（含 Linux 上「退化成明文」的判定） */
  | 'safeStorage.status'
  /** 明文 -> base64 密文 */
  | 'safeStorage.encrypt'
  /** base64 密文 -> { 明文, 是否需要重新加密 }；解不开时抛错 */
  | 'safeStorage.decrypt'

/** `safeStorage.decrypt` 的结果：Electron 会提示系统密钥轮换过，该重写这份密文 */
export interface SafeStoragePlaintext {
  plaintext: string
  shouldReEncrypt: boolean
}

export interface SafeStorageStatus {
  available: boolean
}

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

/**
 * host -> shell 的**流式事件**（一次 RPC 之后陆续到来的分片）。
 *
 * 只有流式 API 用它（现在只有 AI 对话的 SSE）。`requestId` 由 host 在 `open` 时
 * 生成，shell 拿它找到发起那次请求的窗口，再转给渲染进程 —— 所以它和 `rpc-result`
 * 是两条并行的通道，同一个请求会先回 `rpc-result`（带 requestId），再持续来事件。
 */
export interface HostStreamEvent {
  type: 'stream-event'
  requestId: string
  event: unknown
}

export function isHostStreamEvent(value: unknown): value is HostStreamEvent {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { type?: unknown; requestId?: unknown }
  return candidate.type === 'stream-event' && typeof candidate.requestId === 'string'
}
