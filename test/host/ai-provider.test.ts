import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AiProviderService,
  AiProviderServiceError
} from '../../packages/host/src/services/ai-provider.ts'
import { ProviderConfigStore } from '../../packages/host/src/services/ai-provider-config.ts'
import { SecretVault } from '../../packages/host/src/services/secrets.ts'
import type { SecretsBackend } from '../../packages/host/src/services/secrets.ts'
import { AI_PROVIDER_ERROR_CODES } from '../../packages/contracts/src/ai-provider/index.ts'

/**
 * AI 供应商服务（host 侧）。
 *
 * 只测不碰网络的那一半：配置读写、密钥是否落盘、领域错误码、`open` 的入口校验。
 * 真正的 HTTP 转发在 `ai-provider-http.ts` 里，靠上游的错误码收敛 —— 那部分需要
 * 一个假的 fetch，等真有改动时再补。
 */

/** 能真正往返的假后端（见 secrets.test.ts 的同名思路） */
function fakeBackend(): SecretsBackend {
  return {
    status: async () => ({ available: true }),
    encrypt: async (plaintext) => Buffer.from(`fake${plaintext}`, 'utf-8').toString('base64'),
    decrypt: async (ciphertext) => {
      const text = Buffer.from(ciphertext, 'base64').toString('utf-8')
      if (!text.startsWith('fake')) throw new Error('cannot decrypt')
      return { plaintext: text.slice(4), shouldReEncrypt: false }
    }
  }
}

let base = ''
let configPath = ''

function service(): AiProviderService {
  return new AiProviderService(
    new ProviderConfigStore(configPath),
    new SecretVault(path.join(base, 'secrets'), fakeBackend())
  )
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'nide-ai-'))
  configPath = path.join(base, 'ai-provider', 'providers.json')
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

describe('AiProviderService：配置', () => {
  it('新建供应商：必须带 key，落盘后 configured 为 true', async () => {
    const ai = service()

    const saved = await ai.save({ name: 'DeepSeek', apiKey: 'sk-1' } as never)

    expect(saved.name).toBe('DeepSeek')
    expect(saved.configured).toBe(true)
    expect(saved.default).toBe(true)

    const [listed] = await ai.list()
    expect(listed.id).toBe(saved.id)
    expect(listed.configured).toBe(true)
  })

  it('新建时没有 key 报 keyRequired', async () => {
    await expect(service().save({ name: 'x' } as never)).rejects.toMatchObject({
      providerError: { code: AI_PROVIDER_ERROR_CODES.keyRequired }
    })
  })

  it('改 Base URL 但不重输 key 时拒绝（防止把已存的 key 转发出去）', async () => {
    const ai = service()
    const saved = await ai.save({ name: 'x', apiKey: 'sk-1' } as never)

    await expect(
      ai.save({ id: saved.id, baseURL: 'https://evil.example', apiKey: '' } as never)
    ).rejects.toBeInstanceOf(AiProviderServiceError)
  })

  it('不带 key 保存已有供应商：沿用旧 key，configured 仍为 true', async () => {
    const ai = service()
    const saved = await ai.save({ name: 'x', apiKey: 'sk-1' } as never)

    const updated = await ai.save({ id: saved.id, model: 'deepseek-chat' } as never)
    expect(updated.configured).toBe(true)
    expect(updated.model).toBe('deepseek-chat')
  })

  it('删除供应商：配置与密钥一起清掉', async () => {
    const ai = service()
    const saved = await ai.save({ name: 'x', apiKey: 'sk-1' } as never)

    await ai.remove(saved.id)

    expect(await ai.list()).toEqual([])
    const keyFile = path.join(base, 'secrets', 'builtin.ai-provider', `${saved.id}.bin`)
    await expect(fs.access(keyFile)).rejects.toThrow()
  })
})

describe('AiProviderService：open 的入口校验', () => {
  it('不支持的路径直接拒绝（不会发起请求）', async () => {
    const result = await service().open(
      { method: 'GET', path: '/v1/models', body: '{}' } as never,
      () => undefined
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: AI_PROVIDER_ERROR_CODES.invalidRequest }
    })
  })

  it('空请求体拒绝', async () => {
    const result = await service().open(
      { method: 'POST', path: '/chat/completions', body: '' } as never,
      () => undefined
    )

    expect(result.ok).toBe(false)
  })

  it('没有配置供应商时给出 providerNotFound', async () => {
    const result = await service().open(
      { method: 'POST', path: '/chat/completions', body: '{"messages":[]}' } as never,
      () => undefined
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: AI_PROVIDER_ERROR_CODES.providerNotFound }
    })
  })
})
