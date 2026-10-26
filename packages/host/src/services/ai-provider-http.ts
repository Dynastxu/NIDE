import {
  AI_PROVIDER_ERROR_CODES,
  mapProviderError,
  parseModelsResponse,
  type ModelInfo,
  type ProviderError
} from '../../../../src/shared/ai-provider/index.ts'

/**
 * 供应商请求失败。`status` 为 0 表示网络层失败（没拿到 HTTP 响应）。
 */
export class ProviderRequestError extends Error {
  // 显式字段而不是参数属性：host 直接跑 .ts，Node 的类型剥离不支持 `constructor(readonly x)`
  readonly status: number
  readonly providerError: ProviderError

  constructor(status: number, providerError: ProviderError) {
    super(providerError.message)
    this.status = status
    this.providerError = providerError
    this.name = 'ProviderRequestError'
  }
}

// host 的 tsconfig 没有 DOM lib（`HeadersInit` 在那边），这里用等价的普通对象类型
function authHeaders(apiKey: string, accept: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: accept
  }
}

/**
 * 上游错误文案里若回显了 Authorization，把它抹掉再交给渲染进程。
 *
 * 正常的 DeepSeek 不会这么做，但 Base URL 是用户可填的（本地反代 / 兼容服务），
 * 不能假设对面守规矩。
 */
function redactSecret(text: string, secret: string): string {
  if (!secret) return text
  return text.split(secret).join('[redacted]')
}

function upstreamError(status: number, apiKey: string, raw: unknown): ProviderRequestError {
  const mapped = mapProviderError(status, raw)
  return new ProviderRequestError(status, {
    ...mapped,
    message: redactSecret(mapped.message, apiKey)
  })
}

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text()
    if (text.length === 0) return null
    try {
      return JSON.parse(text)
    } catch {
      return { message: text.slice(0, 500) }
    }
  } catch {
    return null
  }
}

function networkError(err: unknown): ProviderRequestError {
  const message =
    err instanceof Error && err.name === 'AbortError'
      ? '请求已取消'
      : '无法连接供应商，请检查网络或 Base URL'

  return new ProviderRequestError(0, {
    code:
      err instanceof Error && err.name === 'AbortError'
        ? AI_PROVIDER_ERROR_CODES.aborted
        : AI_PROVIDER_ERROR_CODES.networkError,
    message,
    status: 0
  })
}

/**
 * `GET /models`。
 *
 * 同时承担两件事：验证 API Key（401 会在这里暴露），以及拿模型列表。
 * 比“发一条 chat 试试”便宜得多，也不会消耗 token。
 */
export async function fetchModels(
  baseURL: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<ModelInfo[]> {
  const timeout = AbortSignal.timeout(15_000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

  let response: Response
  try {
    response = await fetch(`${baseURL}/models`, {
      method: 'GET',
      headers: authHeaders(apiKey, 'application/json'),
      signal: combined
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new ProviderRequestError(0, {
        code: AI_PROVIDER_ERROR_CODES.networkError,
        message: '连接供应商超时',
        status: 0
      })
    }
    throw networkError(err)
  }

  if (!response.ok) {
    throw upstreamError(response.status, apiKey, await readErrorBody(response))
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ProviderRequestError(200, {
      code: AI_PROVIDER_ERROR_CODES.upstreamError,
      message: '供应商返回的模型列表不是合法 JSON'
    })
  }

  const models = parseModelsResponse(payload)
  if (models.length === 0) {
    throw new ProviderRequestError(200, {
      code: AI_PROVIDER_ERROR_CODES.upstreamError,
      message: '供应商没有返回任何可用模型'
    })
  }

  return models
}

/**
 * 发起一次 chat completion，返回原始 Response。
 *
 * 刻意不解析 SSE：供应商响应里有 `reasoning_content`、`tool_calls` 这些字段，
 * 任何“先解析再重组”的转发都可能丢字段。调用方拿 `response.body` 原样读取即可。
 */
export async function openChatCompletion(
  baseURL: string,
  apiKey: string,
  body: string,
  signal: AbortSignal
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(apiKey, 'text/event-stream'),
      body,
      signal
    })
  } catch (err) {
    throw networkError(err)
  }

  if (!response.ok) {
    throw upstreamError(response.status, apiKey, await readErrorBody(response))
  }

  return response
}

/**
 * 把 SSE 响应体逐块读出来交给 onChunk。
 *
 * `TextDecoder({ stream: true })` 处理跨 chunk 的多字节字符：直接 `chunk.toString()`
 * 会把一个中文字符从中间截断，表现为界面上偶发乱码。
 */
export async function readResponseStream(
  response: Response,
  onChunk: (text: string) => void
): Promise<void> {
  if (!response.body) {
    throw new ProviderRequestError(200, {
      code: AI_PROVIDER_ERROR_CODES.upstreamError,
      message: '供应商返回了空响应体'
    })
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      onChunk(decoder.decode(value, { stream: true }))
    }
    const tail = decoder.decode()
    if (tail.length > 0) onChunk(tail)
  } finally {
    // 流被 abort 时 releaseLock 可能抛“still locked”；这里只是尽力释放，
    // 真正的错误由上面的 read() 抛出，不能被清理动作盖掉。
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}
