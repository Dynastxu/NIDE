/**
 * 密钥仓的**契约**：端口形状与两个领域错误。
 *
 * 放在 contracts 而不是 secrets 包里，是因为消费方（AI 供应商）按端口编程，不该
 * import 实现包：`secrets` 的实现细节是「密文落盘 + safeStorage 反向桥」，
 * `ai` 只需要「按 owner/key 取明文」这一件事。
 *
 * 两个错误类必须**只有一份定义**：`ai` 用 `instanceof` 区分「解不开」与「别的
 * 失败」，实现包再定义一份就会让判断永远为 false。
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
 * 密钥仓端口（host 内部接口，**没有 RPC**）。
 *
 * owner 是调用方给的命名空间常量（例如 AI 供应商固定用自己的 owner），key 是
 * 条目名；两者都不来自渲染进程载荷。
 */
export interface SecretVault {
  /** 系统加密能不能用。`false` 时写入会抛 SecretStorageUnavailableError */
  isAvailable(): Promise<boolean>
  has(owner: string, key: string): Promise<boolean>
  /** 读明文。**只允许 host 内部调用**，不要把它暴露成 RPC。 */
  get(owner: string, key: string): Promise<string | null>
  write(owner: string, key: string, value: string): Promise<void>
  delete(owner: string, key: string): Promise<void>
}
