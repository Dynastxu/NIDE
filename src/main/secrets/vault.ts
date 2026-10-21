import { app, safeStorage } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isSafePathSegment } from '@shared/ai-provider'
import { loggerFor } from '../logger'

const logger = loggerFor('secrets')

/**
 * 系统级加密不可用。**不降级成明文**：写不进去比写一份明文强。
 */
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
 * 按插件分命名空间的密钥仓。
 *
 * 设计要点：
 * - 落盘的是 `safeStorage` 的密文，不是明文；
 * - `owner` 由调用方（主进程服务）用常量传入，**不来自 IPC 载荷**。渲染进程
 *   没有任何读取明文的通道，只有“写入 / 删除 / 是否已配置”；
 * - 文件名是 `<owner>/<key>.bin`，owner 与 key 都必须是安全路径段，
 *   避免 `../` 把文件写到别处。
 *
 * 当前 owner 只有 `builtin.ai-provider`。等插件后端沙箱落地后，owner 应该来自
 * 进程绑定而不是调用参数；这一层接口不用改。
 */
export class SecretVault {
  private availability: boolean | null = null

  constructor(private readonly rootDir?: string) {}

  private root(): string {
    return this.rootDir ?? path.join(app.getPath('userData'), 'secrets')
  }

  private file(owner: string, key: string): string {
    if (!isSafePathSegment(owner)) throw new Error(`非法的密钥所有者: ${owner}`)
    if (!isSafePathSegment(key)) throw new Error(`非法的密钥名: ${key}`)

    const root = path.resolve(this.root())
    const file = path.resolve(root, owner, `${key}.bin`)

    // 双保险：段校验已经挡住了 ../，这里再确认一次没有跑出根目录
    if (!file.startsWith(root + path.sep)) {
      throw new Error('密钥路径越界')
    }
    return file
  }

  async isAvailable(): Promise<boolean> {
    if (this.availability !== null) return this.availability

    let available: boolean
    try {
      available = await safeStorage.isAsyncEncryptionAvailable()
    } catch {
      // 老 Electron / 平台不支持异步 API 时退回同步探测
      available = safeStorage.isEncryptionAvailable()
    }

    /**
     * Linux 上没有可用 secret store 时，safeStorage 会退回硬编码密码的
     * `basic_text`。那等于没加密，宁可不存。
     */
    if (available && process.platform === 'linux') {
      try {
        if (safeStorage.getSelectedStorageBackend() === 'basic_text') available = false
      } catch {
        available = false
      }
    }

    // 只缓存“可用”：不可用可能是启动早期 / 临时锁屏，下次再问一次系统
    if (available) this.availability = true
    else {
      logger.warn('OS secure storage is unavailable; API keys will not be saved')
    }
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

  /** 读明文。**只允许主进程内部调用**，不要把它暴露成 IPC。 */
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
      const decrypted = await safeStorage.decryptStringAsync(encrypted)
      if (decrypted.shouldReEncrypt) {
        // 系统密钥轮换了：用新密钥重新落盘，下次读就不用再转一次
        await this.write(owner, key, decrypted.result)
      }
      return decrypted.result
    } catch (err) {
      logger.error('Failed to decrypt a stored secret', { owner, key, error: err })
      throw new SecretDecryptError(err)
    }
  }

  async write(owner: string, key: string, value: string): Promise<void> {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('密钥不能为空')
    }
    if (!(await this.isAvailable())) throw new SecretStorageUnavailableError()

    const encrypted = await safeStorage.encryptStringAsync(value)
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

export const secretVault = new SecretVault()
