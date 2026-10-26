import fs from 'node:fs/promises'
import path from 'node:path'
import {
  PROVIDER_CONFIG_VERSION,
  parseAiProviderConfigFile
} from '../../../../src/shared/ai-provider/index.ts'
import type { AiProviderConfigFile } from '../../../../src/shared/ai-provider/index.ts'

/**
 * 供应商**非密**配置的落盘（host 侧）。
 *
 * 和密钥分开：这个文件里只有 baseURL / model / thinking 这些可以随便读的东西，
 * 密钥在 `secrets/<pluginId>/<providerId>.bin`（密文）。分开的好处是设置页展示列表
 * 时不需要碰密钥仓，读配置的代码也永远不会顺手把 key 带出去。
 *
 * 写入串行化 + 原子替换：两个设置窗口同时保存时不会出现半份 JSON。
 * 路径由 host 入口注入（`<userData>/ai-provider/providers.json`，与搬迁前一致）。
 */

function warn(message: string, fields?: Record<string, unknown>): void {
  if (fields) console.warn(`[nide-host] ${message}`, fields)
  else console.warn(`[nide-host] ${message}`)
}

export class ProviderConfigStore {
  private cache: AiProviderConfigFile | null = null
  private writeChain: Promise<void> = Promise.resolve()
  // 显式字段而不是参数属性：host 直接跑 .ts，Node 的类型剥离不支持 `constructor(private x)`
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async read(): Promise<AiProviderConfigFile> {
    if (this.cache) return structuredClone(this.cache)

    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      this.cache = parseAiProviderConfigFile(JSON.parse(raw))
    } catch (err) {
      // 首次启动（文件不存在）与文件损坏走同一条：空配置不是错误
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        warn('Failed to read the AI provider config, using defaults', { error: err })
      }
      this.cache = {
        version: PROVIDER_CONFIG_VERSION,
        defaultProviderId: null,
        providers: []
      }
    }

    return structuredClone(this.cache)
  }

  /** 整份替换。调用方负责先把数据收敛成合法形状 */
  async save(next: AiProviderConfigFile): Promise<void> {
    this.cache = structuredClone(next)

    // 串行写：后一次一定要在前一次落盘之后才开始，否则 rename 可能互相覆盖
    this.writeChain = this.writeChain.catch(() => undefined).then(() => this.persist(next))

    return this.writeChain
  }

  private async persist(next: AiProviderConfigFile): Promise<void> {
    const target = this.filePath
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`

    try {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: 'utf-8',
        mode: 0o600
      })
      await fs.rename(tmp, target)
    } catch (err) {
      await fs.rm(tmp, { force: true })
      warn('Failed to write the AI provider config', { error: err })
      throw err
    }
  }
}
