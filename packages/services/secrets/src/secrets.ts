import fs from 'node:fs/promises'
import path from 'node:path'
import { isSafePathSegment } from '../../../../packages/contracts/src/ai-provider/index.ts'
import { shell } from '../../../kernel/src/shell.ts'
import type {
  SafeStoragePlaintext,
  SafeStorageStatus
} from '../../../../packages/contracts/src/host-rpc/index.ts'

/**
 * 按插件分命名空间的密钥仓（host 侧）。
 *
 * 与搬迁前（`src/main/secrets/vault.ts`）的区别只有一处：`safeStorage` 是 Electron
 * 的 API，而这里跑在 host —— 于是把「加解密」抽成一个后端接口，生产实现走反向桥
 * （`shell.call('safeStorage.*')`），测试注入假后端。文件读写仍在这里，因为
 * `<userData>/secrets` 本来就是 host 的目录。
 *
 * 设计要点（与搬迁前一致）：
 * - 落盘的是 `safeStorage` 的密文，不是明文；
 * - `owner` 由调用方用常量传入，**不来自 IPC 载荷**；
 * - 文件名是 `<owner>/<key>.bin`，两段都必须是安全路径段，避免 `../` 写到别处。
 */

/** 系统级加密不可用。**不降级成明文**：写不进去比写一份明文强。 */
export class SecretStorageUnavailableError extends Error {
  constructor() {
    super('系统安全存储不可用，无法保存 API Key')
    this.name = 'SecretStorageUnavailableError'
  }
}

/** 密文读得出来但解不开（换了机器 / 换了系统用户 / 文件损坏） */
export class SecretDecryptError extends Error {
  constructor(cause: unknown) {
    super('已保存的 API Key 无法解密，请重新录入')
    this.name = 'SecretDecryptError'
    this.cause = cause
  }
}

/**
 * 加解密后端。
 *
 * 抽成接口是为了让「谁来做系统加密」可换：生产是 Electron 的 `safeStorage`，
 * 测试是假的。仓库里只有 Windows/macOS/Linux 一个实现，所以不做过度设计 ——
 * 三个方法，够用。
 */
export interface SecretsBackend {
  status(): Promise<SafeStorageStatus>
  /** 明文 -> base64 密文 */
  encrypt(plaintext: string): Promise<string>
  decrypt(ciphertext: string): Promise<SafeStoragePlaintext>
}

/** 生产实现：请 shell 用 Electron 的 `safeStorage` 做 */
export const shellSecretsBackend: SecretsBackend = {
  status: () => shell.call<SafeStorageStatus>('safeStorage.status'),
  encrypt: (plaintext) => shell.call<string>('safeStorage.encrypt', [plaintext]),
  decrypt: (ciphertext) => shell.call<SafeStoragePlaintext>('safeStorage.decrypt', [ciphertext])
}

function warn(message: string, fields?: Record<string, unknown>): void {
  if (fields) console.warn(`[nide-host] ${message}`, fields)
  else console.warn(`[nide-host] ${message}`)
}

function error(message: string, fields?: Record<string, unknown>): void {
  if (fields) console.error(`[nide-host] ${message}`, fields)
  else console.error(`[nide-host] ${message}`)
}

export class SecretVault {
  private availability: boolean | null = null
  // 显式字段而不是参数属性：host 直接跑 .ts，Node 的类型剥离不支持 `constructor(private x)`
  private readonly rootDir: string
  private readonly backend: SecretsBackend

  constructor(rootDir: string, backend: SecretsBackend = shellSecretsBackend) {
    this.rootDir = rootDir
    this.backend = backend
  }

  private file(owner: string, key: string): string {
    if (!isSafePathSegment(owner)) throw new Error(`非法的密钥所有者: ${owner}`)
    if (!isSafePathSegment(key)) throw new Error(`非法的密钥名: ${key}`)

    const root = path.resolve(this.rootDir)
    const file = path.resolve(root, owner, `${key}.bin`)

    // 双保险：段校验已经挡住了 ../，这里再确认一次没有跑出根目录
    if (!file.startsWith(root + path.sep)) {
      throw new Error('密钥路径越界')
    }
    return file
  }

  async isAvailable(): Promise<boolean> {
    if (this.availability !== null) return this.availability

    let available = false
    try {
      available = (await this.backend.status()).available
    } catch (err) {
      warn('Failed to probe the OS secure storage', { error: err })
    }

    // 只缓存「可用」：不可用可能是启动早期 / 临时锁屏，下次再问一次系统
    if (available) this.availability = true
    else warn('OS secure storage is unavailable; API keys will not be saved')

    return available
  }

  async has(owner: string, key: string): Promise<boolean> {
    try {
      await fs.access(this.file(owner, key))
      return true
    } catch {
      return false
    }
  }

  /** 读明文。**只允许 host 内部调用**，不要把它暴露成 RPC。 */
  async get(owner: string, key: string): Promise<string | null> {
    const file = this.file(owner, key)

    let encrypted: Buffer
    try {
      encrypted = await fs.readFile(file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }

    try {
      const decrypted = await this.backend.decrypt(encrypted.toString('base64'))
      if (decrypted.shouldReEncrypt) {
        // 系统密钥轮换了：用新密钥重新落盘，下次读就不用再转一次
        await this.write(owner, key, decrypted.plaintext)
      }
      return decrypted.plaintext
    } catch (err) {
      error('Failed to decrypt a stored secret', { owner, key, error: err })
      throw new SecretDecryptError(err)
    }
  }

  async write(owner: string, key: string, value: string): Promise<void> {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('密钥不能为空')
    }
    if (!(await this.isAvailable())) throw new SecretStorageUnavailableError()

    const encrypted = Buffer.from(await this.backend.encrypt(value), 'base64')
    const file = this.file(owner, key)

    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })

    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, encrypted, { mode: 0o600 })
    try {
      await fs.rename(tmp, file)
    } catch (err) {
      await fs.rm(tmp, { force: true })
      throw err
    }
  }

  async delete(owner: string, key: string): Promise<void> {
    await fs.rm(this.file(owner, key), { force: true })
  }
}
