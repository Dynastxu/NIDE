import { randomUUID } from 'node:crypto'
import {
  AI_PROVIDER_ERROR_CODES,
  AI_PROVIDER_PLUGIN_ID,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  MAX_CHAT_BODY_BYTES,
  MAX_PROVIDERS,
  PROVIDER_CONFIG_VERSION,
  buildChatRequestBody,
  isAllowedChatPath,
  normalizeBaseURL,
  normalizeModelId,
  normalizeProviderName,
  normalizeReasoningEffort,
  normalizeThinking,
  parseModelsResponse,
  type AiProviderConfigFile,
  type ChatOpenRequest,
  type ChatOpenResult,
  type ChatStreamEvent,
  type ProviderConfig,
  type ProviderError,
  type ProviderSummary,
  type SaveProviderRequest,
  type TestProviderRequest,
  type TestProviderResult
} from '../../../../packages/contracts/src/ai-provider/index.ts'

import { SecretDecryptError, type SecretVault } from './secrets.ts'
import { ProviderConfigStore } from './ai-provider-config.ts'
import {
  ProviderRequestError,
  fetchModels,
  openChatCompletion,
  readResponseStream
} from './ai-provider-http.ts'

/** 日志出口：host 的 console 会被 shell 的 stdout 接管，落进同一份日志文件 */
const logger = {
  info: (message: string, fields?: Record<string, unknown>): void => {
    if (fields) console.info(`[nide-host] ${message}`, fields)
    else console.info(`[nide-host] ${message}`)
  },
  warn: (message: string, fields?: Record<string, unknown>): void => {
    if (fields) console.warn(`[nide-host] ${message}`, fields)
    else console.warn(`[nide-host] ${message}`)
  },
  error: (message: string, fields?: Record<string, unknown>): void => {
    if (fields) console.error(`[nide-host] ${message}`, fields)
    else console.error(`[nide-host] ${message}`)
  },
  debug: (message: string, fields?: Record<string, unknown>): void => {
    if (fields) console.debug(`[nide-host] ${message}`, fields)
    else console.debug(`[nide-host] ${message}`)
  }
}

/** 服务层错误：带上可以直接交给渲染进程的 code/message */
export class AiProviderServiceError extends Error {
  // 显式字段而不是参数属性：host 直接跑 .ts，Node 的类型剥离不支持 `constructor(readonly x)`
  readonly providerError: ProviderError

  constructor(providerError: ProviderError) {
    super(providerError.message)
    this.providerError = providerError
    this.name = 'AiProviderServiceError'
  }
}

interface InflightChat {
  controller: AbortController
  providerId: string
}

function toError(err: unknown): ProviderError {
  if (err instanceof AiProviderServiceError) return err.providerError
  if (err instanceof ProviderRequestError) return err.providerError
  if (err instanceof SecretDecryptError) {
    return { code: AI_PROVIDER_ERROR_CODES.keyUnavailable, message: err.message }
  }

  return {
    code: AI_PROVIDER_ERROR_CODES.upstreamError,
    message: err instanceof Error ? err.message : '未知错误'
  }
}

/**
 * AI 供应商服务。
 *
 * 这一层现在是**插件后端的替身**：真正该跑在 `builtin.ai-provider` 的独立进程里，
 * 但插件后端沙箱还没做，所以先落在主进程。接口刻意按“服务”切（list/save/test/
 * open/abort），以后搬到子进程时只换传输，不改调用方。
 *
 * 安全约束：
 * - `vault.get` 只在这里调用，读到的明文只用于拼 `Authorization` 头；
 * - 任何返回值都不含 key；
 * - 日志只记 providerId / model / requestId / 状态码，不记 body 与 header。
 */
export class AiProviderService {
  private readonly inflight = new Map<string, InflightChat>()
  // 显式字段而不是参数属性：host 直接跑 .ts，Node 的类型剥离不支持 `constructor(private x)`
  private readonly store: ProviderConfigStore
  private readonly vault: SecretVault
  private readonly owner: string

  constructor(
    store: ProviderConfigStore,
    vault: SecretVault,
    owner: string = AI_PROVIDER_PLUGIN_ID
  ) {
    this.store = store
    this.vault = vault
    this.owner = owner
  }

  async list(): Promise<ProviderSummary[]> {
    const config = await this.store.read()
    const summaries: ProviderSummary[] = []

    for (const provider of config.providers) {
      let configured = false
      try {
        configured = await this.vault.has(this.owner, provider.id)
      } catch (err) {
        // 读不了密钥文件时按“未配置”展示，不要把整个列表打挂
        logger.warn('Failed to check the stored key', { providerId: provider.id, error: err })
      }

      summaries.push({
        ...provider,
        configured,
        default: provider.id === config.defaultProviderId
      })
    }

    return summaries
  }

  async save(request: SaveProviderRequest): Promise<ProviderSummary> {
    const config = await this.store.read()

    const existing = request.id
      ? (config.providers.find((provider) => provider.id === request.id) ?? null)
      : null

    if (request.id && !existing) {
      throw new AiProviderServiceError({
        code: AI_PROVIDER_ERROR_CODES.providerNotFound,
        message: '供应商不存在，可能已被删除'
      })
    }

    const id = existing?.id ?? randomUUID()
    const baseURL = normalizeBaseURL(
      request.baseURL ?? existing?.baseURL ?? DEFAULT_DEEPSEEK_BASE_URL
    )
    if (!baseURL) {
      throw new AiProviderServiceError({
        code: AI_PROVIDER_ERROR_CODES.invalidBaseURL,
        message: 'Base URL 不合法，只支持 http/https 且不能带查询参数'
      })
    }

    const model = normalizeModelId(request.model ?? existing?.model ?? DEFAULT_DEEPSEEK_MODEL)
    if (!model) {
      throw new AiProviderServiceError({
        code: AI_PROVIDER_ERROR_CODES.invalidModel,
        message: '模型 id 不合法'
      })
    }

    const apiKey = typeof request.apiKey === 'string' ? request.apiKey.trim() : ''
    if (!existing && apiKey.length === 0) {
      throw new AiProviderServiceError({
        code: AI_PROVIDER_ERROR_CODES.keyRequired,
        message: '新建供应商时必须填写 API Key'
      })
    }

    /**
     * 改地址必须同时给新 key。
     *
     * 否则任何能调这个 IPC 的渲染进程都可以先把 baseURL 指向自己的服务器、
     * 再触发一次请求，把已保存的 key 送到那边 —— key 没被“读”出来，但被转发
     * 出去了，效果一样。要求重输 key 后，发出去的是调用方自己提供的值。
     */
    if (existing && existing.baseURL !== baseURL && apiKey.length === 0) {
      throw new AiProviderServiceError({
        code: AI_PROVIDER_ERROR_CODES.keyRequired,
        message: '修改 Base URL 需要重新输入 API Key'
      })
    }

    if (apiKey.length > 0) {
      try {
        await this.vault.write(this.owner, id, apiKey)
      } catch (err) {
        throw new AiProviderServiceError({
          code: AI_PROVIDER_ERROR_CODES.storageUnavailable,
          message: err instanceof Error ? err.message : 'API Key 保存失败'
        })
      }
    }

    const now = new Date().toISOString()
    const provider: ProviderConfig = {
      id,
      kind: 'deepseek',
      name: normalizeProviderName(request.name ?? existing?.name),
      baseURL,
      model,
      thinking: normalizeThinking(request.thinking ?? existing?.thinking),
      reasoningEffort: normalizeReasoningEffort(
        request.reasoningEffort ?? existing?.reasoningEffort
      ),
      // Base URL 换了，旧的模型列表就不可信了；同一地址下保留缓存，离线也能选
      // 设置页刚测出来的模型列表优先；没带就沿用同一地址的旧缓存
      models: Array.isArray(request.models)
        ? parseModelsResponse({ data: request.models.slice(0, 50) })
        : existing && existing.baseURL === baseURL
          ? existing.models
          : [],
      createdAt: existing?.createdAt || now,
      updatedAt: now
    }

    if (!existing && config.providers.length >= MAX_PROVIDERS) {
      throw new AiProviderServiceError({
        code: AI_PROVIDER_ERROR_CODES.invalidRequest,
        message: `最多只能配置 ${MAX_PROVIDERS} 个供应商`
      })
    }

    const providers = existing
      ? config.providers.map((item) => (item.id === id ? provider : item))
      : [...config.providers, provider]

    const next: AiProviderConfigFile = {
      version: PROVIDER_CONFIG_VERSION,
      defaultProviderId: config.defaultProviderId ?? id,
      providers
    }

    await this.store.save(next)
    logger.info('Provider saved', {
      providerId: id,
      model: provider.model,
      keyUpdated: apiKey.length > 0
    })

    let configured = false
    try {
      configured = await this.vault.has(this.owner, id)
    } catch (err) {
      logger.warn('Failed to check the stored key after saving', { providerId: id, error: err })
    }

    return {
      ...provider,
      configured,
      default: next.defaultProviderId === id
    }
  }

  async remove(providerId: string): Promise<void> {
    const config = await this.store.read()
    if (!config.providers.some((provider) => provider.id === providerId)) return

    this.abortProvider(providerId)
    await this.vault.delete(this.owner, providerId)

    const providers = config.providers.filter((provider) => provider.id !== providerId)
    const next: AiProviderConfigFile = {
      version: PROVIDER_CONFIG_VERSION,
      defaultProviderId:
        config.defaultProviderId === providerId
          ? (providers[0]?.id ?? null)
          : config.defaultProviderId,
      providers
    }

    await this.store.save(next)
    logger.info('Provider removed', { providerId })
  }

  async test(request: TestProviderRequest): Promise<TestProviderResult> {
    try {
      const { baseURL, apiKey, providerId } = await this.resolveTestTarget(request)
      const models = await fetchModels(baseURL, apiKey)

      // 已保存的供应商顺手更新模型缓存：下次离线打开设置页也能看到列表。
      // 缓存写失败不该让“测试连接成功”变成失败，忽略即可。
      if (providerId) {
        try {
          await this.cacheModels(providerId, models, baseURL)
        } catch (err) {
          logger.warn('Failed to cache the model list', { providerId, error: err })
        }
      }

      return { ok: true, models }
    } catch (err) {
      return { ok: false, error: toError(err) }
    }
  }

  /**
   * 开始一次透明转发。
   *
   * 返回 `requestId` 而不是 Promise<Response>：SSE 是长连接，宿主用事件把分片
   * 推给发起窗口。错误分两段——解析/鉴权失败在返回值里，连接后的错误走事件。
   */
  async open(
    request: ChatOpenRequest,
    emit: (event: ChatStreamEvent) => void
  ): Promise<ChatOpenResult> {
    if (request.method !== 'POST' || !isAllowedChatPath(request.path)) {
      return {
        ok: false,
        error: { code: AI_PROVIDER_ERROR_CODES.invalidRequest, message: '不支持的请求' }
      }
    }

    if (typeof request.body !== 'string' || request.body.length === 0) {
      return {
        ok: false,
        error: { code: AI_PROVIDER_ERROR_CODES.invalidRequest, message: '请求体为空' }
      }
    }

    if (Buffer.byteLength(request.body, 'utf-8') > MAX_CHAT_BODY_BYTES) {
      return {
        ok: false,
        error: { code: AI_PROVIDER_ERROR_CODES.invalidRequest, message: '请求体过大' }
      }
    }

    const config = await this.store.read()
    const provider = this.resolveProvider(config, request.providerId)
    if (!provider) {
      return {
        ok: false,
        error: { code: AI_PROVIDER_ERROR_CODES.providerNotFound, message: '还没有配置 AI 供应商' }
      }
    }

    let apiKey: string | null
    try {
      apiKey = await this.vault.get(this.owner, provider.id)
    } catch (err) {
      return { ok: false, error: toError(err) }
    }

    if (!apiKey) {
      return {
        ok: false,
        error: { code: AI_PROVIDER_ERROR_CODES.keyUnavailable, message: '供应商还没有配置 API Key' }
      }
    }

    const body = buildChatRequestBody(provider, request.body)
    if (!body) {
      return {
        ok: false,
        error: {
          code: AI_PROVIDER_ERROR_CODES.invalidRequest,
          message: '请求体不是合法的 chat completions JSON'
        }
      }
    }

    const requestId = randomUUID()
    const controller = new AbortController()
    this.inflight.set(requestId, { controller, providerId: provider.id })

    void this.runChat(provider, apiKey, body, requestId, controller, emit).finally(() => {
      this.inflight.delete(requestId)
    })

    return { ok: true, requestId }
  }

  abort(requestId: string): void {
    const entry = this.inflight.get(requestId)
    if (!entry) return
    entry.controller.abort()
    logger.debug('Chat aborted', { requestId, providerId: entry.providerId })
  }

  abortAll(): void {
    for (const entry of this.inflight.values()) entry.controller.abort()
    this.inflight.clear()
  }

  abortProvider(providerId: string): void {
    for (const [requestId, entry] of this.inflight) {
      if (entry.providerId !== providerId) continue
      entry.controller.abort()
      this.inflight.delete(requestId)
    }
  }

  private async runChat(
    provider: ProviderConfig,
    apiKey: string,
    body: string,
    requestId: string,
    controller: AbortController,
    emit: (event: ChatStreamEvent) => void
  ): Promise<void> {
    try {
      const response = await openChatCompletion(provider.baseURL, apiKey, body, controller.signal)
      const contentType = response.headers.get('content-type') ?? ''

      emit({
        requestId,
        type: 'start',
        status: response.status,
        ...(contentType ? { contentType } : {})
      })

      if (contentType.includes('text/event-stream')) {
        await readResponseStream(response, (data) => {
          emit({ requestId, type: 'chunk', data })
        })
      } else {
        // 非流式请求（stream:false）：整份响应作为一块发回去
        emit({ requestId, type: 'chunk', data: await response.text() })
      }

      emit({ requestId, type: 'end', status: response.status })
      logger.info('Chat completed', { requestId, providerId: provider.id, status: response.status })
    } catch (err) {
      const aborted = controller.signal.aborted
      const error: ProviderError = aborted
        ? { code: AI_PROVIDER_ERROR_CODES.aborted, message: '请求已取消' }
        : toError(err)

      const status = err instanceof ProviderRequestError ? err.status : undefined
      logger.warn('Chat failed', { requestId, providerId: provider.id, code: error.code, status })
      emit({ requestId, type: 'error', error, ...(status !== undefined ? { status } : {}) })
    }
  }

  private resolveProvider(
    config: AiProviderConfigFile,
    providerId?: string
  ): ProviderConfig | null {
    if (providerId) {
      return config.providers.find((provider) => provider.id === providerId) ?? null
    }
    const id = config.defaultProviderId ?? config.providers[0]?.id
    return id ? (config.providers.find((provider) => provider.id === id) ?? null) : null
  }

  private async resolveTestTarget(
    request: TestProviderRequest
  ): Promise<{ baseURL: string; apiKey: string; providerId?: string }> {
    const draftKey = typeof request.apiKey === 'string' ? request.apiKey.trim() : ''

    if (request.providerId) {
      const config = await this.store.read()
      const provider = config.providers.find((item) => item.id === request.providerId)
      if (!provider) {
        throw new AiProviderServiceError({
          code: AI_PROVIDER_ERROR_CODES.providerNotFound,
          message: '供应商不存在，可能已被删除'
        })
      }

      const apiKey = draftKey.length > 0 ? draftKey : await this.vault.get(this.owner, provider.id)
      if (!apiKey) {
        throw new AiProviderServiceError({
          code: AI_PROVIDER_ERROR_CODES.keyUnavailable,
          message: '供应商还没有配置 API Key'
        })
      }

      const requestedBaseURL =
        request.baseURL !== undefined ? normalizeBaseURL(request.baseURL) : provider.baseURL
      if (!requestedBaseURL) {
        throw new AiProviderServiceError({
          code: AI_PROVIDER_ERROR_CODES.invalidBaseURL,
          message: 'Base URL 不合法'
        })
      }

      /**
       * 草稿地址只有在**同时给了草稿 key** 时才允许覆盖。
       *
       * 否则调用方可以传 `{ providerId, baseURL: 'https://evil' }`，让主进程拿
       * 已保存的 key 去请求自己的服务器 —— key 没有通过返回值泄露，但被写进
       * 发往 evil 的 Authorization 头里，等同于泄露。只改地址不重输 key 时，
       * 直接拒绝，而不是悄悄退回旧地址（那会让用户以为测的是新地址）。
       */
      if (draftKey.length === 0 && requestedBaseURL !== provider.baseURL) {
        throw new AiProviderServiceError({
          code: AI_PROVIDER_ERROR_CODES.keyRequired,
          message: '修改 Base URL 后需要重新输入 API Key 才能测试'
        })
      }

      return { baseURL: requestedBaseURL, apiKey, providerId: provider.id }
    }

    const baseURL = normalizeBaseURL(request.baseURL ?? DEFAULT_DEEPSEEK_BASE_URL)
    if (!baseURL) {
      throw new AiProviderServiceError({
        code: AI_PROVIDER_ERROR_CODES.invalidBaseURL,
        message: 'Base URL 不合法'
      })
    }
    if (draftKey.length === 0) {
      throw new AiProviderServiceError({
        code: AI_PROVIDER_ERROR_CODES.keyRequired,
        message: '请先填写 API Key'
      })
    }

    return { baseURL, apiKey: draftKey }
  }

  private async cacheModels(
    providerId: string,
    models: ProviderConfig['models'],
    testedBaseURL: string
  ): Promise<void> {
    const config = await this.store.read()
    let changed = false

    const providers = config.providers.map((provider) => {
      if (provider.id !== providerId) return provider

      // 用户改了地址但还没保存时，测试拿到的是新地址的模型，不能写进旧配置
      if (provider.baseURL !== testedBaseURL) return provider

      changed = true
      return { ...provider, models, updatedAt: new Date().toISOString() }
    })

    if (!changed) return
    await this.store.save({ ...config, providers })
  }
}
