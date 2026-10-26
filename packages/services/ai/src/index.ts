import path from 'node:path'
import type { NideContext } from '../../../kernel/src/context.ts'
import type { SecretVault } from '../../secrets/src/secrets.ts'
import { AiProviderService, AiProviderServiceError } from './ai-provider.ts'
import { ProviderConfigStore } from './ai-provider-config.ts'
import {
  AI_PROVIDER_ERROR_CODES,
  type ChatOpenRequest,
  type ChatStreamEvent,
  type ProviderError,
  type SaveProviderRequest,
  type TestProviderRequest
} from '../../../contracts/src/ai-provider/index.ts'

/**
 * AI 供应商服务（`ai.*`）。
 *
 * 分片出口是**注入**的：`apply` 里先放一个空 sink，宿主入口在 IPC 接好之后调
 * `setStreamSink(...)` 把它接到父端口（`stream-event`）。这样服务本身不认识
 * transport，独立运行（`--once`）时也不会因为「没有 shell」而报错。
 *
 * 密钥在 secrets 服务里（`ctx.services.require('secrets')`），配置在 userData 下。
 */
export interface AiService {
  /** 由宿主入口接上：把 SSE 分片送到 shell（再转给发起窗口） */
  setStreamSink(sink: ((event: ChatStreamEvent) => void) | null): void
}

export const aiService = {
  name: 'nide:service:ai',

  apply(ctx: NideContext): void {
    const vault = ctx.services.require<SecretVault>('secrets')
    const service = new AiProviderService(
      new ProviderConfigStore(path.join(ctx.env.userDataDir, 'ai-provider', 'providers.json')),
      vault
    )

    let sink: ((event: ChatStreamEvent) => void) | null = null

    const handle: AiService = {
      setStreamSink: (next) => {
        sink = next
      }
    }

    ctx.services.provide('ai', handle)

    ctx.rpc.register('ai', {
      list: async () => {
        try {
          return await service.list()
        } catch (error) {
          console.warn('[nide-host] failed to list AI providers', { error })
          return []
        }
      },

      /**
       * `save` / `remove` 把**领域错误**当成返回值（`{ ok:false, error:{ code, message } }`），
       * 而不是抛出去：错误码是给渲染进程看的数据（`keyRequired` / `baseUrlConflict` …），
       * RPC 的错误包装只剩一个 message，跨进程后就分不清了。
       */
      save: async (request) => {
        try {
          return { ok: true, provider: await service.save(request as SaveProviderRequest) }
        } catch (error) {
          return { ok: false, error: toProviderError(error) }
        }
      },

      remove: async (providerId) => {
        try {
          await service.remove(String(providerId ?? ''))
          return { ok: true }
        } catch (error) {
          return { ok: false, error: toProviderError(error) }
        }
      },

      test: (request) => service.test(request as TestProviderRequest),

      open: (request) =>
        service.open(request as ChatOpenRequest, (event) => {
          sink?.(event)
        }),

      abort: (requestId) => {
        service.abort(String(requestId ?? ''))
      },

      abortAll: () => {
        service.abortAll()
      }
    })
  }
}

/** 把服务抛出的错误收敛成给渲染进程看的领域错误 */
function toProviderError(error: unknown): ProviderError {
  if (error instanceof AiProviderServiceError) return error.providerError
  return {
    code: AI_PROVIDER_ERROR_CODES.internal,
    message: error instanceof Error ? error.message : 'AI 供应商操作失败'
  }
}

/** profile 通过 `kind: service` 行指向本文件，宿主入口取 default 后 apply */
export default aiService
