import { describe, expect, it } from 'vitest'
import {
  AI_PROVIDER_ERROR_CODES,
  buildChatRequestBody,
  mapProviderError,
  normalizeBaseURL,
  parseAiProviderConfigFile,
  parseModelsResponse,
  parseProviderConfig,
  type ProviderConfig
} from '@nide/contracts/ai-provider'

const PROVIDER: ProviderConfig = {
  id: 'provider-1',
  kind: 'deepseek',
  name: 'DeepSeek',
  baseURL: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  thinking: 'enabled',
  reasoningEffort: 'high',
  models: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

describe('normalizeBaseURL', () => {
  it('去掉末尾斜杠，保留 /v1 这类路径', () => {
    expect(normalizeBaseURL('https://api.deepseek.com/')).toBe('https://api.deepseek.com')
    expect(normalizeBaseURL('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1')
  })

  it('允许本地 http（Ollama / 反代）', () => {
    expect(normalizeBaseURL('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434')
  })

  it('拒绝非 http(s)、带凭据、带 query/hash 的值', () => {
    for (const raw of [
      'ftp://example.com',
      'https://user:pass@example.com',
      'https://example.com?key=1',
      'https://example.com#x',
      'not a url',
      '',
      null,
      42
    ]) {
      expect(normalizeBaseURL(raw)).toBeNull()
    }
  })
})

describe('parseModelsResponse', () => {
  it('映射 DeepSeek 的模型元数据并去重', () => {
    const models = parseModelsResponse({
      data: [
        {
          id: 'deepseek-flash',
          name: 'DeepSeek Flash',
          context_window: 1_000_000,
          max_output_tokens: 393_216,
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
          effort: { supported_levels: ['low', 'high', 'max'] }
        },
        { id: 'deepseek-flash' },
        { id: 'bad id!' }
      ]
    })

    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'deepseek-flash',
      name: 'DeepSeek Flash',
      contextWindow: 1_000_000,
      maxOutputTokens: 393_216,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      effortLevels: ['low', 'high', 'max']
    })
  })

  it('也认得已落盘的 camelCase 模型缓存', () => {
    const models = parseModelsResponse({
      data: [
        {
          id: 'deepseek-v4-pro',
          contextWindow: 1_000_000,
          maxOutputTokens: 384_000,
          effortLevels: ['low', 'high', 'max']
        }
      ]
    })

    expect(models[0]).toMatchObject({
      id: 'deepseek-v4-pro',
      contextWindow: 1_000_000,
      maxOutputTokens: 384_000,
      effortLevels: ['low', 'high', 'max']
    })
  })

  it('不是 { data: [] } 时返回空数组，不抛异常', () => {
    expect(parseModelsResponse(null)).toEqual([])
    expect(parseModelsResponse({})).toEqual([])
    expect(parseModelsResponse({ data: 'nope' })).toEqual([])
  })
})

describe('parseProviderConfig / parseAiProviderConfigFile', () => {
  it('坏条目逐条丢弃，重复 id 只留一条', () => {
    const config = parseAiProviderConfigFile({
      version: 1,
      defaultProviderId: 'missing',
      providers: [
        PROVIDER,
        { ...PROVIDER, name: 'duplicate' },
        { ...PROVIDER, id: 'bad id!' },
        { ...PROVIDER, id: 'no-url', baseURL: 'ftp://x' },
        { ...PROVIDER, id: 'no-model', model: '' }
      ]
    })

    expect(config.providers).toHaveLength(1)
    expect(config.providers[0]?.id).toBe('provider-1')
    expect(config.defaultProviderId).toBe('provider-1')
  })

  it('未知版本 / 坏文件退回空配置', () => {
    expect(parseAiProviderConfigFile(null).providers).toEqual([])
    expect(parseAiProviderConfigFile({ providers: 'nope' }).providers).toEqual([])
  })

  it('单个配置缺少 id / baseURL / model 时返回 null', () => {
    expect(parseProviderConfig({ ...PROVIDER, id: '' })).toBeNull()
    expect(parseProviderConfig({ ...PROVIDER, baseURL: 'nope' })).toBeNull()
    expect(parseProviderConfig({ ...PROVIDER, model: '' })).toBeNull()
  })
})

describe('buildChatRequestBody', () => {
  it('强制使用配置里的模型，并去掉调用方自带的鉴权字段', () => {
    const body = buildChatRequestBody(
      PROVIDER,
      JSON.stringify({
        model: 'attacker-picked-model',
        messages: [{ role: 'user', content: '写一段开头' }],
        api_key: 'leak',
        Authorization: 'Bearer leak'
      })
    )

    expect(body).not.toBeNull()
    const parsed = JSON.parse(body!) as Record<string, unknown>

    expect(parsed.model).toBe('deepseek-flash')
    expect(parsed.api_key).toBeUndefined()
    expect(parsed.Authorization).toBeUndefined()
    expect(parsed.thinking).toEqual({ type: 'enabled' })
    expect(parsed.reasoning_effort).toBe('high')
  })

  it('关闭思考时清掉调用方给的 reasoning_effort', () => {
    const body = buildChatRequestBody(
      { ...PROVIDER, thinking: 'disabled' },
      JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'max'
      })
    )
    const parsed = JSON.parse(body!) as Record<string, unknown>

    expect(parsed.thinking).toEqual({ type: 'disabled' })
    expect(parsed.reasoning_effort).toBeUndefined()
  })

  it('调用方显式给了 thinking / effort 时不覆盖', () => {
    const body = buildChatRequestBody(
      PROVIDER,
      JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'disabled' },
        reasoning_effort: 'low'
      })
    )
    const parsed = JSON.parse(body!) as Record<string, unknown>

    expect(parsed.thinking).toEqual({ type: 'disabled' })
    expect(parsed.reasoning_effort).toBe('low')
  })

  it('坏 JSON / 缺 messages / 空 messages 一律拒绝', () => {
    expect(buildChatRequestBody(PROVIDER, 'not json')).toBeNull()
    expect(buildChatRequestBody(PROVIDER, JSON.stringify({ model: 'x' }))).toBeNull()
    expect(buildChatRequestBody(PROVIDER, JSON.stringify({ messages: [] }))).toBeNull()
  })
})

describe('mapProviderError', () => {
  it('把常见状态码映射成可读文案', () => {
    expect(mapProviderError(401, null).code).toBe(AI_PROVIDER_ERROR_CODES.unauthorized)
    expect(mapProviderError(402, null).code).toBe(AI_PROVIDER_ERROR_CODES.insufficientBalance)
    expect(mapProviderError(429, null).code).toBe(AI_PROVIDER_ERROR_CODES.rateLimited)
    expect(mapProviderError(503, null).code).toBe(AI_PROVIDER_ERROR_CODES.upstreamUnavailable)
  })

  it('其它状态码优先用供应商自己的 message', () => {
    const error = mapProviderError(400, { error: { message: 'bad tool schema' } })
    expect(error.code).toBe(AI_PROVIDER_ERROR_CODES.upstreamError)
    expect(error.message).toBe('bad tool schema')
  })
})
