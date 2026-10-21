import { ipcMain, type WebContents } from 'electron'
import {
  AI_PROVIDER_CHANNELS,
  AI_PROVIDER_ERROR_CODES,
  AI_PROVIDER_PLUGIN_ID,
  type ChatOpenRequest,
  type ChatStreamEvent,
  type ProviderError,
  type RemoveProviderResult,
  type SaveProviderRequest,
  type SaveProviderResult,
  type TestProviderRequest
} from '@shared/ai-provider'
import { loggerFor } from '../logger'
import { getDisabledPlugins } from '../plugin-host/preference'
import { secretVault } from '../secrets/vault'
import { ProviderConfigStore } from '../services/ai-provider/config-store'
import { AiProviderService, AiProviderServiceError } from '../services/ai-provider'

const logger = loggerFor('ai-provider')

/**
 * 服务是懒创建的：`ProviderConfigStore` 的默认路径要调 app.getPath('userData')，
 * 这个模块可能在 app ready 之前就被 import。第一次 IPC 调用一定在 ready 之后。
 */
let service: AiProviderService | null = null

function getService(): AiProviderService {
  if (!service) service = new AiProviderService(new ProviderConfigStore(), secretVault)
  return service
}

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

/**
 * 插件被禁用时服务也停用。
 *
 * 设置页在禁用后已经从树上消失，但 Agent / 其它调用方仍可能拿旧 requestId 打
 * 过来。这里挡在 IPC 入口，比在每个方法里判断更不容易漏。
 */
function isProviderEnabled(): boolean {
  return !getDisabledPlugins().includes(AI_PROVIDER_PLUGIN_ID)
}

function pluginUnavailable(): ProviderError {
  return {
    code: AI_PROVIDER_ERROR_CODES.pluginUnavailable,
    message: 'AI 供应商插件已被禁用，请在「设置 -> 插件」里启用'
  }
}

function errorPayload(err: unknown): ProviderError {
  if (err instanceof AiProviderServiceError) return err.providerError

  logger.error('AI provider operation failed', { error: err })
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
      service?.abort(requestId)
      cancelled.add(requestId)
      targets.delete(requestId)
      buffered.delete(requestId)
    }
  })
}

export function registerAiProviderIPC(): void {
  ipcMain.handle(AI_PROVIDER_CHANNELS.list, () =>
    isProviderEnabled() ? getService().list() : Promise.resolve([])
  )

  ipcMain.handle(
    AI_PROVIDER_CHANNELS.save,
    async (_event, payload: unknown): Promise<SaveProviderResult> => {
      if (!isRecord(payload)) {
        return {
          ok: false,
          error: { code: AI_PROVIDER_ERROR_CODES.invalidRequest, message: '请求格式不合法' }
        }
      }
      if (!isProviderEnabled()) return { ok: false, error: pluginUnavailable() }

      try {
        return { ok: true, provider: await getService().save(payload as SaveProviderRequest) }
      } catch (err) {
        return { ok: false, error: errorPayload(err) }
      }
    }
  )

  ipcMain.handle(
    AI_PROVIDER_CHANNELS.remove,
    async (_event, providerId: unknown): Promise<RemoveProviderResult> => {
      if (typeof providerId !== 'string' || providerId.length === 0) {
        return {
          ok: false,
          error: { code: AI_PROVIDER_ERROR_CODES.invalidRequest, message: '供应商 id 不合法' }
        }
      }
      if (!isProviderEnabled()) return { ok: false, error: pluginUnavailable() }

      try {
        await getService().remove(providerId)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: errorPayload(err) }
      }
    }
  )

  ipcMain.handle(AI_PROVIDER_CHANNELS.test, (_event, payload: unknown) => {
    if (!isRecord(payload)) {
      return {
        ok: false,
        error: { code: AI_PROVIDER_ERROR_CODES.invalidRequest, message: '请求格式不合法' }
      }
    }
    if (!isProviderEnabled()) return { ok: false, error: pluginUnavailable() }
    return getService().test(payload as TestProviderRequest)
  })

  ipcMain.handle(AI_PROVIDER_CHANNELS.open, async (event, payload: unknown) => {
    if (!isRecord(payload)) {
      return {
        ok: false,
        error: { code: AI_PROVIDER_ERROR_CODES.invalidRequest, message: '请求格式不合法' }
      }
    }
    if (!isProviderEnabled()) return { ok: false, error: pluginUnavailable() }

    const sender = event.sender
    watchSender(sender)

    const result = await getService().open(payload as unknown as ChatOpenRequest, deliver)

    if (result.ok) {
      // 窗口在 open 等待期间被关掉：请求已经启动，立刻取消，别让它在后台跑完
      if (sender.isDestroyed()) {
        getService().abort(result.requestId)
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
  })

  ipcMain.handle(AI_PROVIDER_CHANNELS.abort, (_event, requestId: unknown) => {
    if (typeof requestId !== 'string') return
    getService().abort(requestId)
    cancelled.add(requestId)
    targets.delete(requestId)
    buffered.delete(requestId)
  })
}

/** 退出 / 重建窗口前调用：把所有还在跑的 SSE 全部取消，别把 fetch 挂在后台 */
export function shutdownAiProviderIPC(): void {
  service?.abortAll()
  targets.clear()
  buffered.clear()
  cancelled.clear()
  // 刻意不清 watched：destroyed 监听只该挂一次，重新启用插件后同一窗口还会复用
}
