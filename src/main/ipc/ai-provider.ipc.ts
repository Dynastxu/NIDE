import { ipcMain, type WebContents } from 'electron'
import {
  AI_PROVIDER_CHANNELS,
  AI_PROVIDER_ERROR_CODES,
  AI_PROVIDER_PLUGIN_ID,
  type ChatOpenRequest,
  type ChatOpenResult,
  type ChatStreamEvent,
  type ProviderError,
  type ProviderSummary,
  type RemoveProviderResult,
  type SaveProviderRequest,
  type SaveProviderResult,
  type TestProviderRequest,
  type TestProviderResult
} from '@shared/ai-provider'
import { loggerFor } from '../logger'
import { getDisabledPlugins } from '../plugin-host/preference'
import { invokeHost, subscribeHostStream } from '../host/process'

const logger = loggerFor('ai-provider')

/**
 * AI 供应商的 **shell 边界**。
 *
 * 服务本身已经搬进 host（`packages/host/src/services/ai-provider.ts`）：配置、
 * 密钥、SSE 都在那边。这一层只剩三件事：
 *
 * 1. **可用性**：插件被禁用时不转发（设置页已经消失，但 Agent 可能还拿着旧 requestId）；
 * 2. **窗口归属**：`open` 返回的 requestId 记下发起它的窗口，后面的分片只回给那个
 *    窗口（不是广播）；窗口在请求中途被关掉就取消；
 * 3. **形状校验**：IPC 载荷来自渲染进程，先挡掉明显不合法的形状。
 *
 * 流式分片走 `subscribeHostStream`：host 用父端口发 `stream-event`，这里按
 * requestId 找到窗口再转给渲染进程 —— 和搬迁前「本地服务直接回调」的时序一致。
 */

/** requestId -> 发起这次请求的窗口。只回给发起者，不广播 */
const targets = new Map<string, WebContents>()
/** 已经在监听 destroyed 的窗口，避免每次 open 都挂一个 once */
const watched = new Set<WebContents>()
/** open 返回前就到达的分片（理论上极少，但窗口注册与首个 chunk 之间有竞态） */
const buffered = new Map<string, ChatStreamEvent[]>()
/** 已经 abort / 窗口销毁的请求：迟到的 chunk 直接丢掉，不再进缓冲区 */
const cancelled = new Set<string>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProviderEnabled(): boolean {
  return !getDisabledPlugins().includes(AI_PROVIDER_PLUGIN_ID)
}

function pluginUnavailable(): ProviderError {
  return {
    code: AI_PROVIDER_ERROR_CODES.pluginUnavailable,
    message: 'AI 供应商插件已被禁用，请在「设置 -> 插件」里启用'
  }
}

function invalidRequest(): { ok: false; error: ProviderError } {
  return {
    ok: false,
    error: { code: AI_PROVIDER_ERROR_CODES.invalidRequest, message: '请求格式不合法' }
  }
}

/** host 不可达时的兜底错误 */
function hostUnavailable(error: unknown): ProviderError {
  logger.error('AI provider call failed', { error })
  return { code: AI_PROVIDER_ERROR_CODES.internal, message: 'AI 供应商操作失败' }
}

function deliver(event: ChatStreamEvent): void {
  if (cancelled.has(event.requestId)) {
    if (event.type === 'end' || event.type === 'error') cancelled.delete(event.requestId)
    return
  }

  const target = targets.get(event.requestId)
  if (!target) {
    if (event.type === 'end' || event.type === 'error') return
    const queue = buffered.get(event.requestId) ?? []
    queue.push(event)
    buffered.set(event.requestId, queue)
    return
  }

  if (!target.isDestroyed()) {
    try {
      target.send(AI_PROVIDER_CHANNELS.event, event)
    } catch (err) {
      // 窗口在 isDestroyed 检查和 send 之间被销毁：当它已经走了，别再往上抛
      logger.warn('Failed to deliver an AI stream event', {
        requestId: event.requestId,
        error: err
      })
      targets.delete(event.requestId)
      buffered.delete(event.requestId)
      cancelled.delete(event.requestId)
      return
    }
  }
  if (event.type === 'end' || event.type === 'error') {
    targets.delete(event.requestId)
    buffered.delete(event.requestId)
    cancelled.delete(event.requestId)
  }
}

function watchSender(sender: WebContents): void {
  if (watched.has(sender)) return
  watched.add(sender)

  sender.once('destroyed', () => {
    watched.delete(sender)
    for (const [requestId, target] of targets) {
      if (target !== sender) continue
      void invokeHost('ai', 'abort', [requestId]).catch(() => undefined)
      cancelled.add(requestId)
      targets.delete(requestId)
      buffered.delete(requestId)
    }
  })
}

export function registerAiProviderIPC(): void {
  /**
   * host 的分片：`event.requestId` 决定转给哪个窗口。订阅放在注册时（只一次），
   * 而不是每次 open 都订一遍。
   */
  subscribeHostStream((message) => {
    deliver(message.event as ChatStreamEvent)
  })

  ipcMain.handle(AI_PROVIDER_CHANNELS.list, async (): Promise<ProviderSummary[]> => {
    if (!isProviderEnabled()) return []
    try {
      return await invokeHost<ProviderSummary[]>('ai', 'list', [])
    } catch (error) {
      logger.error('Failed to list AI providers through host', { error })
      return []
    }
  })

  ipcMain.handle(
    AI_PROVIDER_CHANNELS.save,
    async (_event, payload: unknown): Promise<SaveProviderResult> => {
      if (!isRecord(payload)) return invalidRequest()
      if (!isProviderEnabled()) return { ok: false, error: pluginUnavailable() }

      try {
        return await invokeHost<SaveProviderResult>('ai', 'save', [payload as SaveProviderRequest])
      } catch (error) {
        return { ok: false, error: hostUnavailable(error) }
      }
    }
  )

  ipcMain.handle(
    AI_PROVIDER_CHANNELS.remove,
    async (_event, providerId: unknown): Promise<RemoveProviderResult> => {
      if (typeof providerId !== 'string' || providerId.length === 0) return invalidRequest()
      if (!isProviderEnabled()) return { ok: false, error: pluginUnavailable() }

      try {
        return await invokeHost<RemoveProviderResult>('ai', 'remove', [providerId])
      } catch (error) {
        return { ok: false, error: hostUnavailable(error) }
      }
    }
  )

  ipcMain.handle(
    AI_PROVIDER_CHANNELS.test,
    async (_event, payload: unknown): Promise<TestProviderResult> => {
      if (!isRecord(payload)) return invalidRequest()
      if (!isProviderEnabled()) return { ok: false, error: pluginUnavailable() }

      try {
        return await invokeHost<TestProviderResult>('ai', 'test', [payload as TestProviderRequest])
      } catch (error) {
        return { ok: false, error: hostUnavailable(error) }
      }
    }
  )

  ipcMain.handle(
    AI_PROVIDER_CHANNELS.open,
    async (event, payload: unknown): Promise<ChatOpenResult> => {
      if (!isRecord(payload)) return invalidRequest()
      if (!isProviderEnabled()) return { ok: false, error: pluginUnavailable() }

      const sender = event.sender
      watchSender(sender)

      let result: ChatOpenResult
      try {
        result = await invokeHost<ChatOpenResult>('ai', 'open', [
          payload as unknown as ChatOpenRequest
        ])
      } catch (error) {
        return { ok: false, error: hostUnavailable(error) }
      }

      if (result.ok) {
        // 窗口在 open 等待期间被关掉：请求已经启动，立刻取消，别让它在后台跑完
        if (sender.isDestroyed()) {
          void invokeHost('ai', 'abort', [result.requestId]).catch(() => undefined)
          cancelled.add(result.requestId)
          buffered.delete(result.requestId)
          return {
            ok: false,
            error: { code: AI_PROVIDER_ERROR_CODES.aborted, message: '请求窗口已关闭' }
          }
        }

        cancelled.delete(result.requestId)
        targets.set(result.requestId, sender)

        // open 返回前到达的分片按顺序补发；补发完再删队列
        const queued = buffered.get(result.requestId)
        if (queued) {
          buffered.delete(result.requestId)
          for (const item of queued) deliver(item)
        }
      }

      return result
    }
  )

  ipcMain.handle(AI_PROVIDER_CHANNELS.abort, (_event, requestId: unknown) => {
    if (typeof requestId !== 'string') return
    void invokeHost('ai', 'abort', [requestId]).catch(() => undefined)
    cancelled.add(requestId)
    targets.delete(requestId)
    buffered.delete(requestId)
  })
}

/** 退出 / 重建窗口前调用：把所有还在跑的 SSE 全部取消，别把 fetch 挂在后台 */
export function shutdownAiProviderIPC(): void {
  void invokeHost('ai', 'abortAll').catch(() => undefined)
  targets.clear()
  buffered.clear()
  cancelled.clear()
  // 刻意不清 watched：destroyed 监听只该挂一次，重新启用插件后同一窗口还会复用
}
