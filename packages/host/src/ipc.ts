import process from 'node:process'
import { isShellCallResult } from '../../../src/shared/host-rpc/index.ts'
import type {
  RpcRequest,
  RpcResponse,
  ShellCallResult
} from '../../../src/shared/host-rpc/index.ts'

/**
 * Host 与「父进程 / renderer」之间的最小 IPC 通道（MVP）。
 *
 * 三条链路：
 * 1. shell -> host：Electron `process.parentPort`（或 Node `process.send`），
 *    用于 ready / ping / shutdown，以及把 renderer 的 MessagePort 交给 host；
 * 2. host -> shell：同一条通道回包；
 * 3. renderer <-> host：shell 建 `MessageChannelMain`，一个 port 给 host、
 *    一个给 renderer，两边直连，不经过 shell 转发。
 *
 * 现在 renderer 侧只实现 `ping` / `pong`；真正的 RPC 分发（namespace/method、
 * 超时、取消、流）放在阶段 2。
 *
 * TODO:
 * - 按 namespace/method 分发到 ctx 上的服务
 * - 请求 id、超时、AbortSignal、流式响应
 * - renderer 断开时清理 port（现在依赖 port 自身的 close）
 */

interface MessagePortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: unknown): void
  start?(): void
  close?(): void
}

interface ParentPortLike extends MessagePortLike {}

interface InboundMessage {
  data: unknown
  ports?: MessagePortLike[]
}

interface Transport {
  onMessage: (listener: (message: InboundMessage) => void) => void
  postMessage: (message: unknown) => void
}

export interface HostIpcOptions {
  /** 启动完成后回给父进程的载荷。 */
  ready: Record<string, unknown>
  /** 收到 shutdown 时执行；实现方负责退出进程。 */
  onShutdown: () => void
  /** renderer 发来的 RPC 请求；返回结果会被原样送回同一个 port。 */
  onRpc?: (request: RpcRequest) => Promise<RpcResponse>
  /** shell 对 `shell-call` 的回包（反向 RPC 的结果）。 */
  onShellResult?: (message: ShellCallResult) => void
}

export interface HostIpcHandle {
  /** 当前进程是否真的挂在父进程下（独立运行时为 false）。 */
  attached: boolean
  /** 当前已连接的 renderer 数量。 */
  rendererCount: () => number
  /** 给父进程发消息。 */
  send: (message: unknown) => void
  /** 广播给所有已连接的 renderer。 */
  broadcast: (message: unknown) => void
}

function electronTransport(): Transport | null {
  const port = (process as unknown as { parentPort?: ParentPortLike }).parentPort
  if (!port) return null
  return {
    onMessage: (listener) => {
      port.on('message', (event) => listener(event))
      port.start?.()
    },
    postMessage: (message) => port.postMessage(message)
  }
}

function nodeTransport(): Transport | null {
  const send = process.send
  if (typeof send !== 'function') return null
  return {
    onMessage: (listener) => {
      process.on('message', (message) => listener({ data: message }))
    },
    postMessage: (message) => {
      process.send?.(message)
    }
  }
}

export function attachHostIpc(options: HostIpcOptions): HostIpcHandle {
  const transport = electronTransport() ?? nodeTransport()

  if (!transport) {
    return {
      attached: false,
      rendererCount: () => 0,
      send: () => {
        // 独立运行时没有父进程可发；保持空实现，调用方不必分支。
      },
      broadcast: () => {
        // 没有 renderer 连接。
      }
    }
  }

  const rendererPorts = new Set<MessagePortLike>()
  let shuttingDown = false

  /**
   * 分发一条 RPC，并把结果交给指定的出口。
   *
   * 两个调用方：renderer 直连的 MessagePort，以及 shell 的父端口（`invokeHost`）。
   * 出口不同，请求/响应形状完全相同 —— 所以只写一份，避免两条通道各自长出自己的
   * 错误包装。
   */
  const dispatchRpc = (request: RpcRequest, send: (response: RpcResponse) => void): void => {
    if (!options.onRpc) {
      send({
        type: 'rpc-result',
        id: request.id,
        ok: false,
        error: { code: 'not-implemented', message: 'host RPC is not implemented yet' }
      })
      return
    }

    void options
      .onRpc(request)
      .then(send)
      .catch((error: unknown) => {
        send({
          type: 'rpc-result',
          id: request.id,
          ok: false,
          error: {
            code: 'rpc-failed',
            message: error instanceof Error ? error.message : String(error)
          }
        })
      })
  }

  /** renderer 发来的消息：ping / rpc。 */
  const handleRendererMessage = (port: MessagePortLike, raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return
    const message = raw as { type?: string; id?: string }

    if (message.type === 'ping') {
      port.postMessage({ type: 'pong', id: message.id, ts: Date.now() })
      return
    }

    if (message.type === 'rpc') {
      dispatchRpc(raw as RpcRequest, (response) => port.postMessage(response))
    }
  }

  const attachRendererPort = (port: MessagePortLike, label: unknown): void => {
    rendererPorts.add(port)
    port.on('message', (event) => handleRendererMessage(port, event.data))
    port.start?.()
    port.postMessage({ type: 'connected', label })
  }

  transport.onMessage((inbound) => {
    const message = inbound.data
    if (!message || typeof message !== 'object') return

    const { type } = message as { type?: string }

    if (type === 'attach-port') {
      for (const port of inbound.ports ?? []) {
        attachRendererPort(port, (message as { label?: unknown }).label)
      }
      return
    }

    if (type === 'ping') {
      transport.postMessage({
        type: 'pong',
        id: (message as { id?: string }).id,
        ts: Date.now()
      })
      return
    }

    /**
     * shell → host 的 RPC（`invokeHost`）。
     *
     * 走父端口而不是 renderer 的 port：项目创建时的 `config.initialize` 由主进程发起，
     * 那时窗口可能还没建出来。和 renderer 共用同一个 `onRpc` 注册表。
     */
    if (type === 'rpc') {
      dispatchRpc(message as RpcRequest, (response) => transport.postMessage(response))
      return
    }

    /**
     * shell 对反向调用（`shell-call`）的回包。
     *
     * 和 `rpc-result` 分开两个 type：那个是「我们问出去、对方回」，这个是「对方
     * 执行完我们请它做的事」。合在一起会让回包的归属变得含糊。
     */
    if (type === 'shell-result') {
      if (isShellCallResult(message)) options.onShellResult?.(message)
      return
    }

    if (type === 'shutdown') {
      if (shuttingDown) return
      shuttingDown = true
      for (const port of rendererPorts) port.close?.()
      rendererPorts.clear()
      options.onShutdown()
    }

    // TODO: 其它 type 走 RPC 分发
  })

  transport.postMessage({ type: 'ready', ...options.ready })

  return {
    attached: true,
    rendererCount: () => rendererPorts.size,
    send: (message) => transport.postMessage(message),
    broadcast: (message) => {
      for (const port of rendererPorts) port.postMessage(message)
    }
  }
}
