import type { ShellCall, ShellCallResult, ShellMethod } from '../../../src/shared/host-rpc/index.ts'

/**
 * host 侧的 `ctx.shell`：需要 Electron 的能力（原生主题、`safeStorage`）通过反向
 * RPC 请 shell 执行。
 *
 * 为什么是反向：方向由「谁拥有那份能力」决定，而不是由「谁发起功能」决定。主题偏好
 * 与密钥都该在 host（业务逻辑在那儿），但 `nativeTheme` / `safeStorage` 只有
 * Electron 有。于是 host 把请求发回去，shell 执行完回包。
 *
 * 三条约束：
 *
 * 1. **方法白名单**在协议里（`ShellMethod`），shell 只认那几个；
 * 2. **没挂在 shell 下时 `attached` 为 false**（独立跑 `node packages/host`），
 *    调用直接抛错 —— 调用方自己决定降级，这里不假装成功；
 * 3. **超时**：shell 没回包（窗口全关、进程卡住）就 reject，别让业务无限等。
 */

const DEFAULT_TIMEOUT_MS = 5_000

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class ShellBridge {
  private send: ((message: unknown) => void) | null = null
  private pending = new Map<string, PendingCall>()
  private seq = 0

  /** 是否挂在 shell 下 */
  get attached(): boolean {
    return this.send !== null
  }

  /** 由 host 入口在 IPC 就绪后注入发送函数；独立运行时不会调用 */
  attach(send: (message: unknown) => void): void {
    this.send = send
  }

  /** shell 断开 / 退出：所有等着的调用立刻失败，不留悬挂的 Promise */
  detach(reason = 'shell bridge is not available'): void {
    this.send = null
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
  }

  call<T = unknown>(
    method: ShellMethod,
    args: unknown[] = [],
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    const send = this.send
    if (!send) return Promise.reject(new Error('shell capabilities are not attached'))

    const id = `shell-${++this.seq}`

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })

      try {
        const message: ShellCall = { type: 'shell-call', id, method, args }
        send(message)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** shell 回包：由 IPC 层转进来。返回 false 表示这条回包没人等（超时之后才到的） */
  settle(message: ShellCallResult): boolean {
    const pending = this.pending.get(message.id)
    if (!pending) return false

    this.pending.delete(message.id)
    clearTimeout(pending.timer)

    if (message.ok) {
      pending.resolve(message.result)
    } else {
      const error = new Error(message.error.message) as Error & { code?: string }
      error.code = message.error.code
      pending.reject(error)
    }

    return true
  }
}

export const shell = new ShellBridge()
