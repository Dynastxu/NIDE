import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SecretDecryptError,
  SecretStorageUnavailableError,
  SecretVault
} from '../../packages/host/src/services/secrets.ts'
import type { SecretsBackend } from '../../packages/host/src/services/secrets.ts'

/**
 * 密钥仓（host 侧）。
 *
 * 加解密走注入的后端（生产是 `shell.call('safeStorage.*')`，测试是假的），文件读写
 * 是真的临时目录 —— 这个类一半是路径守卫、一半是「不可用就别存」，都值得钉住。
 */

/**
 * 假后端：把明文**倒过来**当密文。
 *
 * 必须是可逆但不含原文的变换 —— 用「加前缀」的话，落盘内容里还能搜到明文，
 * 「写下去的是密文」那条断言就测不出来了。
 */
function reverseBackend(
  options: { available?: boolean; shouldReEncrypt?: boolean } = {}
): SecretsBackend {
  return {
    status: async () => ({ available: options.available ?? true }),
    encrypt: async (plaintext) =>
      Buffer.from([...plaintext].reverse().join(''), 'utf-8').toString('base64'),
    decrypt: async (ciphertext) => {
      const text = Buffer.from(ciphertext, 'base64').toString('utf-8')
      return {
        plaintext: [...text].reverse().join(''),
        shouldReEncrypt: options.shouldReEncrypt ?? false
      }
    }
  }
}

let base = ''

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'nide-secrets-'))
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

describe('SecretVault：系统安全存储不可用', () => {
  it('不可用时写入失败，而不是降级成明文', async () => {
    const vault = new SecretVault(base, reverseBackend({ available: false }))

    expect(await vault.isAvailable()).toBe(false)
    await expect(vault.write('builtin.ai-provider', 'p1', 'sk-1')).rejects.toBeInstanceOf(
      SecretStorageUnavailableError
    )
    // 一个文件都不该写出去
    await expect(fs.readdir(base)).resolves.toEqual([])
  })

  it('后端抛错时按不可用处理', async () => {
    const broken: SecretsBackend = {
      status: async () => {
        throw new Error('no keyring')
      },
      encrypt: async () => '',
      decrypt: async () => ({ plaintext: '', shouldReEncrypt: false })
    }

    expect(await new SecretVault(base, broken).isAvailable()).toBe(false)
  })
})

describe('SecretVault：读写', () => {
  it('写入后能读回明文，落盘的是密文', async () => {
    const vault = new SecretVault(base, reverseBackend())
    await vault.write('builtin.ai-provider', 'p1', 'sk-secret')

    expect(await vault.has('builtin.ai-provider', 'p1')).toBe(true)
    expect(await vault.get('builtin.ai-provider', 'p1')).toBe('sk-secret')

    const stored = await fs.readFile(path.join(base, 'builtin.ai-provider', 'p1.bin'), 'utf-8')
    expect(stored).not.toContain('sk-secret')
  })

  it('没有文件时 get 给 null（不是抛错）', async () => {
    const vault = new SecretVault(base, reverseBackend())
    expect(await vault.get('builtin.ai-provider', 'nope')).toBeNull()
    expect(await vault.has('builtin.ai-provider', 'nope')).toBe(false)
  })

  it('删掉之后 has/get 都回到空', async () => {
    const vault = new SecretVault(base, reverseBackend())
    await vault.write('builtin.ai-provider', 'p1', 'sk-secret')

    await vault.delete('builtin.ai-provider', 'p1')
    expect(await vault.has('builtin.ai-provider', 'p1')).toBe(false)
    expect(await vault.get('builtin.ai-provider', 'p1')).toBeNull()
  })

  it('解不开时抛 SecretDecryptError（换了机器 / 文件损坏）', async () => {
    const vault = new SecretVault(base, {
      ...reverseBackend(),
      decrypt: async () => {
        throw new Error('cannot decrypt')
      }
    })
    await vault.write('builtin.ai-provider', 'p1', 'sk-secret')

    await expect(vault.get('builtin.ai-provider', 'p1')).rejects.toBeInstanceOf(SecretDecryptError)
  })

  it('系统密钥轮换（shouldReEncrypt）时用新密钥重写一次', async () => {
    const backend = reverseBackend({ shouldReEncrypt: true })
    let encryptions = 0
    const vault = new SecretVault(base, {
      ...backend,
      encrypt: async (plaintext) => {
        encryptions += 1
        return backend.encrypt(plaintext)
      }
    })

    await vault.write('builtin.ai-provider', 'p1', 'sk-secret')
    expect(encryptions).toBe(1)

    // 读的时候后端说「该重新加密了」：业务层要顺手转存一次，下次读就不用再转
    expect(await vault.get('builtin.ai-provider', 'p1')).toBe('sk-secret')
    expect(encryptions).toBe(2)
    expect(await vault.get('builtin.ai-provider', 'p1')).toBe('sk-secret')
  })
})

describe('SecretVault：路径守卫', () => {
  it('owner / key 里的 ../ 一律拒绝', async () => {
    const vault = new SecretVault(base, reverseBackend())

    await expect(vault.write('..', 'p1', 'x')).rejects.toThrow()
    await expect(vault.write('builtin.ai-provider', '../evil', 'x')).rejects.toThrow()
    await expect(vault.get('a/b', 'p1')).rejects.toThrow()
  })
})
