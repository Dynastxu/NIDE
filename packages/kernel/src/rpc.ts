import type {
  RpcFailure,
  RpcRequest,
  RpcResponse,
  RpcSuccess
} from '../../../packages/contracts/src/host-rpc/index.ts'

/**
 * Host 侧 RPC 注册表（MVP）。
 *
 * 一个 namespace 是一个普通对象，method 是它的函数。调用方（renderer）只传
 * JSON 兼容的参数；这里不做 schema 校验 —— 阶段 2 接 DSH 的 Typert 或手写
 * schema 后再补。
 *
 * TODO:
 * - 按 service 自动注册（ctx.<name>）而不是手工 register
 * - 参数 schema 校验与返回值投影
 * - AbortSignal / 超时 / 流式响应
 */

export type RpcHandler = (...args: unknown[]) => unknown | Promise<unknown>
export type RpcNamespace = Record<string, RpcHandler>

function success(id: string, result: unknown): RpcSuccess {
  return { type: 'rpc-result', id, ok: true, result }
}

function failure(id: string, code: string, message: string): RpcFailure {
  return { type: 'rpc-result', id, ok: false, error: { code, message } }
}

export class RpcRegistry {
  private readonly namespaces = new Map<string, RpcNamespace>()

  /** 注册一个 namespace；返回注销函数（与 Cordis 的 effect 语义一致）。 */
  register(namespace: string, handlers: RpcNamespace): () => void {
    this.namespaces.set(namespace, handlers)
    return () => {
      if (this.namespaces.get(namespace) === handlers) this.namespaces.delete(namespace)
    }
  }

  async invoke(request: RpcRequest): Promise<RpcResponse> {
    const handlers = this.namespaces.get(request.namespace)
    if (!handlers) {
      return failure(request.id, 'unknown-namespace', `unknown namespace: ${request.namespace}`)
    }

    const handler = handlers[request.method]
    if (typeof handler !== 'function') {
      return failure(
        request.id,
        'unknown-method',
        `unknown method: ${request.namespace}.${request.method}`
      )
    }

    try {
      const result = await handler(...(Array.isArray(request.args) ? request.args : []))
      return success(request.id, result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return failure(request.id, 'handler-error', message)
    }
  }
}
