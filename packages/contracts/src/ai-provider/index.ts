/**
 * AI 供应商的跨进程契约。
 *
 * 这一层只放**纯数据与纯函数**：类型、通道名、默认值、校验与收敛规则。
 * 读盘、safeStorage、fetch 全部留在主进程（`src/main/services/ai-provider/`），
 * 因为渲染进程在 Chromium 沙箱里既没有 fs，也不该碰 API Key。
 *
 * 安全边界（当前阶段）：
 * - API Key 只在主进程解密，**没有**任何返回明文的 IPC；
 * - 渲染进程拿到的 `ProviderSummary` 里只有 `configured: boolean`；
 * - 设置页写 key 是单向的：明文进、不回读。
 *
 * 这不是进程级插件隔离（插件 UI 仍共享同一个 renderer realm），只是 API 层
 * 的“拿不到”。等插件后端沙箱/隔离运行时落地后，这个契约不需要改。
 */

/** 供应商插件自己的 id。密钥按这个 id 分命名空间存放 */
export const AI_PROVIDER_PLUGIN_ID = 'builtin.ai-provider'

/** DeepSeek 官方 OpenAI 兼容端点。`/v1` 可选，这里用不带版本号的形式 */
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

/**
 * 只在模型列表拉取失败、用户又没选过模型时兜底。
 *
 * 正常路径是 `GET /models` 动态取：DeepSeek 的模型名换过（deepseek-chat ->
 * deepseek-flash），硬编码一个名字迟早会过期。
 */
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash'

export const PROVIDER_CONFIG_VERSION = 1

/** 当前只适配 DeepSeek；类型留成联合，后面加供应商时不用改存储形状 */
export type ProviderKind = 'deepseek'

export type ThinkingMode = 'enabled' | 'disabled'

/**
 * DeepSeek 的思考强度。
 *
 * 刻意不含 `none`：关闭思考是 `thinking.type = 'disabled'`，两者是同一件事的
 * 两种写法，放进同一个下拉框只会让用户以为可以“关掉思考但保留强度”。
 */
export type ReasoningEffort = 'low' | 'high' | 'max'

export interface ModelInfo {
  id: string
  name?: string
  /** 上下文窗口（token），来自 /models 的 context_window */
  contextWindow?: number
  /** 单次最大输出（token），来自 /models 的 max_output_tokens */
  maxOutputTokens?: number
  inputModalities?: string[]
  outputModalities?: string[]
  /** 支持的 reasoning_effort 档位，来自 /models 的 effort.supported_levels */
  effortLevels?: string[]
}

/**
 * 落盘的非密配置。**没有 apiKey 字段**，这是刻意的：
 * 配置文件和密钥文件分开，前者可以随便读，后者只有主进程能解。
 */
export interface ProviderConfig {
  id: string
  kind: ProviderKind
  name: string
  baseURL: string
  model: string
  thinking: ThinkingMode
  reasoningEffort: ReasoningEffort
  /** /models 的缓存，用于设置页离线展示与 Agent 侧上下文预算 */
  models: ModelInfo[]
  createdAt: string
  updatedAt: string
}

/** 发给渲染进程的视图。密钥只以布尔值出现 */
export interface ProviderSummary extends ProviderConfig {
  configured: boolean
  default: boolean
}

export interface AiProviderConfigFile {
  version: number
  defaultProviderId: string | null
  providers: ProviderConfig[]
}

export interface SaveProviderRequest {
  /** 省略表示新建 */
  id?: string
  name?: string
  baseURL?: string
  model?: string
  /** 省略表示保留已存的 key；新建时省略会报 key_required */
  apiKey?: string
  /**
   * 设置页刚测出来的模型列表。带上它可以避免“测试连接成功后一保存，下拉框又空了”：
   * 主进程不为了缓存模型再发一次 /models 请求。非密数据，按不可信输入收敛。
   */
  models?: ModelInfo[]
  thinking?: ThinkingMode
  reasoningEffort?: ReasoningEffort
}

export interface TestProviderRequest {
  /** 已保存的供应商：可以只给 id，key 由主进程读 */
  providerId?: string
  /** 草稿：还没保存时直接测 */
  baseURL?: string
  apiKey?: string
}

export interface ProviderError {
  code: string
  message: string
  /** 上游 HTTP 状态；网络层失败时为 0，本地校验失败时省略 */
  status?: number
}

export interface TestProviderResult {
  ok: boolean
  models?: ModelInfo[]
  error?: ProviderError
}

export type SaveProviderResult =
  { ok: true; provider: ProviderSummary } | { ok: false; error: ProviderError }

export type RemoveProviderResult = { ok: true } | { ok: false; error: ProviderError }

/**
 * Agent 侧的透明转发请求。
 *
 * 不是自定义聊天协议：`path` 只允许 `/chat/completions`，`body` 就是 OpenAI
 * Chat Completions 的 JSON 字符串。供应商插件只做三件事——校验、注入
 * Authorization、把 SSE 原样回传。
 *
 * **调用顺序**：必须先订阅 `onEvent`，再调用 `open`。宿主在 open 返回后会立刻
 * 补发缓冲的 start/chunk，晚注册的监听器收不到已经发出的 IPC。
 */
export interface ChatOpenRequest {
  providerId?: string
  method: 'POST'
  /** 兼容 baseURL 带 /v1 的客户端（AI SDK 的 baseURL 常写成 .../v1） */
  path: '/chat/completions' | '/v1/chat/completions'
  body: string
}

export type ChatOpenResult = { ok: true; requestId: string } | { ok: false; error: ProviderError }

export type ChatStreamEvent =
  | { requestId: string; type: 'start'; status: number; contentType?: string }
  | { requestId: string; type: 'chunk'; data: string }
  | { requestId: string; type: 'end'; status: number }
  | { requestId: string; type: 'error'; error: ProviderError; status?: number }

export const AI_PROVIDER_CHANNELS = {
  list: 'ai-provider:list',
  save: 'ai-provider:save',
  remove: 'ai-provider:remove',
  test: 'ai-provider:test',
  open: 'ai-provider:open',
  abort: 'ai-provider:abort',
  /** 主进程 -> 渲染进程：按 requestId 分片的 SSE */
  event: 'ai-provider:event'
} as const

export const AI_PROVIDER_ERROR_CODES = {
  keyRequired: 'key_required',
  keyUnavailable: 'key_unavailable',
  pluginUnavailable: 'plugin_unavailable',
  storageUnavailable: 'storage_unavailable',
  providerNotFound: 'provider_not_found',
  invalidRequest: 'invalid_request',
  invalidBaseURL: 'invalid_base_url',
  invalidModel: 'invalid_model',
  unauthorized: 'unauthorized',
  insufficientBalance: 'insufficient_balance',
  rateLimited: 'rate_limited',
  upstreamUnavailable: 'upstream_unavailable',
  upstreamError: 'upstream_error',
  networkError: 'network_error',
  aborted: 'aborted',
  internal: 'internal'
} as const

/** 保存供应商数量上限。防止配置文件被脚本灌爆，也够正常的“工作/个人”两套 */
export const MAX_PROVIDERS = 20

/** 单次请求体上限。小说正文可能很长，但 2MB 已经远超一次合理对话 */
export const MAX_CHAT_BODY_BYTES = 2 * 1024 * 1024

/**
 * 模型 id 只用于 JSON 请求体，不参与路径拼接，所以允许 `/` 与 `@`
 * （OpenAI 兼容供应商常见 `vendor/model` 这种写法）。仍然拒绝空白与控制字符。
 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 收敛 Base URL。
 *
 * 允许 http 是为了本地 Ollama / 反代（127.0.0.1），但拒绝 URL 里带用户名密码、
 * query 或 hash：那些部分既没有意义，又容易把密钥顺手写进配置。
 */
export function normalizeBaseURL(raw: unknown): string | null {
  if (typeof raw !== 'string') return null

  const trimmed = raw.trim()
  if (trimmed.length === 0) return null

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password || url.search || url.hash) return null

  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}

export function normalizeProviderName(raw: unknown, fallback = 'DeepSeek'): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value.length > 0 ? value.slice(0, 80) : fallback
}

export function normalizeModelId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return MODEL_ID_RE.test(value) ? value : null
}

export function normalizeThinking(raw: unknown): ThinkingMode {
  return raw === 'disabled' ? 'disabled' : 'enabled'
}

export function normalizeReasoningEffort(raw: unknown): ReasoningEffort {
  return raw === 'low' || raw === 'max' ? raw : 'high'
}

/** 插件 id / 供应商 id 都可能被用作目录名或文件名，统一挡掉路径字符 */
export function isSafePathSegment(value: string): boolean {
  return SEGMENT_RE.test(value)
}

/**
 * 把 /models 的响应收敛成模型列表。
 *
 * 容错读取而不是整份拒绝：DeepSeek 以后多一个字段、少一个字段都不该让设置页
 * 整个空掉。只要求 `id` 合法。
 */
export function parseModelsResponse(raw: unknown): ModelInfo[] {
  if (!isRecord(raw) || !Array.isArray(raw.data)) return []

  const models: ModelInfo[] = []
  const seen = new Set<string>()

  for (const item of raw.data) {
    if (!isRecord(item)) continue
    const id = normalizeModelId(item.id)
    if (!id || seen.has(id)) continue
    seen.add(id)

    const effortLevels = Array.isArray(item.effortLevels)
      ? item.effortLevels.filter((level): level is string => typeof level === 'string')
      : isRecord(item.effort) && Array.isArray(item.effort.supported_levels)
        ? item.effort.supported_levels.filter((level): level is string => typeof level === 'string')
        : undefined

    const inputModalities = Array.isArray(item.inputModalities)
      ? item.inputModalities
      : Array.isArray(item.input_modalities)
        ? item.input_modalities
        : undefined

    const outputModalities = Array.isArray(item.outputModalities)
      ? item.outputModalities
      : Array.isArray(item.output_modalities)
        ? item.output_modalities
        : undefined

    const contextWindow =
      typeof item.contextWindow === 'number'
        ? item.contextWindow
        : typeof item.context_window === 'number'
          ? item.context_window
          : undefined

    const maxOutputTokens =
      typeof item.maxOutputTokens === 'number'
        ? item.maxOutputTokens
        : typeof item.max_output_tokens === 'number'
          ? item.max_output_tokens
          : undefined

    models.push({
      id,
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(inputModalities
        ? {
            inputModalities: inputModalities.filter(
              (value): value is string => typeof value === 'string'
            )
          }
        : {}),
      ...(outputModalities
        ? {
            outputModalities: outputModalities.filter(
              (value): value is string => typeof value === 'string'
            )
          }
        : {}),
      ...(effortLevels ? { effortLevels } : {})
    })
  }

  return models
}

/** 收敛单个供应商配置；坏条目返回 null，由调用方逐条跳过 */
export function parseProviderConfig(raw: unknown): ProviderConfig | null {
  if (!isRecord(raw)) return null

  const id = typeof raw.id === 'string' && isSafePathSegment(raw.id) ? raw.id : null
  const baseURL = normalizeBaseURL(raw.baseURL)
  const model = normalizeModelId(raw.model)

  if (!id || !baseURL || !model) return null
  if (raw.kind !== undefined && raw.kind !== 'deepseek') return null

  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : ''
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt

  return {
    id,
    kind: 'deepseek',
    name: normalizeProviderName(raw.name),
    baseURL,
    model,
    thinking: normalizeThinking(raw.thinking),
    reasoningEffort: normalizeReasoningEffort(raw.reasoningEffort),
    models: Array.isArray(raw.models) ? parseModelsResponse({ data: raw.models }) : [],
    createdAt,
    updatedAt
  }
}

/**
 * 收敛整份配置文件。
 *
 * 和项目里的其它偏好解析同一个原则：坏数据不抛异常、逐项校验、去重；
 * 文件损坏时退回空配置，应用照常启动。
 */
export function parseAiProviderConfigFile(raw: unknown): AiProviderConfigFile {
  const empty: AiProviderConfigFile = {
    version: PROVIDER_CONFIG_VERSION,
    defaultProviderId: null,
    providers: []
  }

  if (!isRecord(raw) || !Array.isArray(raw.providers)) return empty

  const providers: ProviderConfig[] = []
  const seen = new Set<string>()

  for (const item of raw.providers) {
    const provider = parseProviderConfig(item)
    if (!provider || seen.has(provider.id)) continue
    seen.add(provider.id)
    providers.push(provider)
    if (providers.length >= MAX_PROVIDERS) break
  }

  const defaultProviderId =
    typeof raw.defaultProviderId === 'string' && seen.has(raw.defaultProviderId)
      ? raw.defaultProviderId
      : (providers[0]?.id ?? null)

  return { version: PROVIDER_CONFIG_VERSION, defaultProviderId, providers }
}

/**
 * 从供应商响应里抽错误文案。
 *
 * DeepSeek 的形状是 `{ error: { message } }`，但也兼容 OpenAI 的 `{ message }`。
 * 只取 message，不把整个 body 带出去——body 可能很长，也可能包含请求回显。
 */
export function extractUpstreamMessage(raw: unknown): string | null {
  if (!isRecord(raw)) return null
  if (isRecord(raw.error) && typeof raw.error.message === 'string') return raw.error.message
  if (typeof raw.message === 'string') return raw.message
  return null
}

/** 把 HTTP 状态映射成用户能看懂的中文。原始 message 只放在 data 里，不进日志 */
export function mapProviderError(status: number, raw: unknown): ProviderError {
  if (status === 401) {
    return {
      code: AI_PROVIDER_ERROR_CODES.unauthorized,
      message: 'API Key 无效或已过期',
      status
    }
  }
  if (status === 402) {
    return {
      code: AI_PROVIDER_ERROR_CODES.insufficientBalance,
      message: '账户余额不足',
      status
    }
  }
  if (status === 429) {
    return {
      code: AI_PROVIDER_ERROR_CODES.rateLimited,
      message: '请求过于频繁，请稍后重试',
      status
    }
  }
  if (status >= 500) {
    return {
      code: AI_PROVIDER_ERROR_CODES.upstreamUnavailable,
      message: '供应商服务暂时不可用，请稍后重试',
      status
    }
  }

  return {
    code: AI_PROVIDER_ERROR_CODES.upstreamError,
    message: extractUpstreamMessage(raw) ?? `供应商返回 HTTP ${status}`,
    status
  }
}

/**
 * 构造发给 DeepSeek 的请求体。
 *
 * 三件事：
 * 1. `model` 强制用供应商配置里的值，忽略调用方传的——否则 Agent 可以绕过
 *    设置页选定的模型；
 * 2. 补上 thinking / reasoning_effort 默认值（DeepSeek 默认开启思考，
 *    对写作场景未必是用户想要的）；
 * 3. 去掉任何调用方自带的鉴权字段，Authorization 只由主进程加。
 *
 * 返回字符串而不是对象：SSE 转发是透明的，这里只做一次序列化。
 */
export function buildChatRequestBody(provider: ProviderConfig, rawBody: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return null
  }

  if (!isRecord(parsed)) return null
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) return null

  const body: Record<string, unknown> = { ...parsed }
  delete body.api_key
  delete body.apiKey
  delete body.authorization
  delete body.Authorization

  body.model = provider.model

  if (body.thinking === undefined || body.thinking === null) {
    body.thinking = { type: provider.thinking }
  }
  if (provider.thinking === 'disabled') {
    // 关闭思考时 reasoning_effort 没有意义，留着只会让上游按“开启思考”处理
    delete body.reasoning_effort
  } else if (body.reasoning_effort === undefined || body.reasoning_effort === null) {
    body.reasoning_effort = provider.reasoningEffort
  }

  return JSON.stringify(body)
}

/** 只允许这两个路径，避免把转发 IPC 变成任意 HTTP 代理 */
export function isAllowedChatPath(path: unknown): path is ChatOpenRequest['path'] {
  return path === '/chat/completions' || path === '/v1/chat/completions'
}
