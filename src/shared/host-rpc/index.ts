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

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { type?: string; id?: string; ok?: boolean }
  return (
    candidate.type === 'rpc-result' &&
    typeof candidate.id === 'string' &&
    typeof candidate.ok === 'boolean'
  )
}
