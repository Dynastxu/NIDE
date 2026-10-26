import { nativeTheme, safeStorage } from 'electron'
import { isShellCall, type ShellCall, type ShellCallResult } from '@nide/contracts/host-rpc'
import { loggerFor } from '../logger'
import type { UtilityProcess } from 'electron'

/**
 * host 反向调用的**唯一实现处**（D7 的 `ctx.shell`）。
 *
 * 方向与正向 RPC 相反：host 拥有业务（主题偏好、密钥），但这些能力只有 Electron
 * 有。所以 host 发 `shell-call`，这里执行并回 `shell-result`。
 *
 * 三条约束：
 *
 * 1. **白名单**：`ShellMethod` 之外的方法直接拒绝 —— host 拼不出任意 Electron API；
 * 2. **参数校验**：方法名对上了也不代表参数可信，逐个收敛；
 * 3. **错误回给调用方**：不在这里吞掉，host 那边按自己的语义决定降级还是报错。
 */

const logger = loggerFor('shell')

type Handler = (args: unknown[]) => unknown

const handlers: Record<string, Handler> = {
  'nativeTheme.setSource': (args) => {
    const source = args[0]
    if (source !== 'system' && source !== 'light' && source !== 'dark') {
      throw new Error(`invalid nativeTheme source: ${String(source)}`)
    }
    nativeTheme.themeSource = source
    return true
  },

  'nativeTheme.shouldUseDarkColors': () => nativeTheme.shouldUseDarkColors,

  /**
   * 系统安全存储能不能用。
   *
   * 判定照搬搬迁前 `SecretVault` 的那一套：Linux 上没有 secret store 时 Electron 会
   * 退回硬编码密码的 `basic_text`，那等于没加密 —— 宁可不存，也不写一份假密文。
   */
  'safeStorage.status': async () => {
    let available: boolean
    try {
      available = await safeStorage.isAsyncEncryptionAvailable()
    } catch {
      // 老 Electron / 平台不支持异步 API 时退回同步探测
      available = safeStorage.isEncryptionAvailable()
    }

    if (available && process.platform === 'linux') {
      try {
        if (safeStorage.getSelectedStorageBackend() === 'basic_text') available = false
      } catch {
        available = false
      }
    }

    return { available }
  },

  'safeStorage.encrypt': async (args) => {
    const plaintext = args[0]
    if (typeof plaintext !== 'string') throw new Error('safeStorage.encrypt expects a string')

    // 只传 base64：Buffer 跨进程会被结构化克隆成 Uint8Array，两端类型对不上
    const encrypted = await safeStorage.encryptStringAsync(plaintext)
    return encrypted.toString('base64')
  },

  'safeStorage.decrypt': async (args) => {
    const ciphertext = args[0]
    if (typeof ciphertext !== 'string') throw new Error('safeStorage.decrypt expects a string')

    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(ciphertext, 'base64'))
    return { plaintext: decrypted.result, shouldReEncrypt: decrypted.shouldReEncrypt }
  }
}

/** host 发来的 `shell-call`：执行并在同一条父端口上回包 */
export async function handleShellCall(
  message: unknown,
  send: (message: unknown) => void
): Promise<void> {
  if (!isShellCall(message)) return
  const call: ShellCall = message

  const handler = handlers[call.method]
  if (!handler) {
    send(failure(call.id, 'unknown-method', `unknown shell method: ${call.method}`))
    return
  }

  try {
    const result = await handler(call.args)
    const response: ShellCallResult = { type: 'shell-result', id: call.id, ok: true, result }
    send(response)
  } catch (error) {
    logger.warn('Shell capability failed', { method: call.method, error })
    send(
      failure(call.id, 'shell-call-failed', error instanceof Error ? error.message : String(error))
    )
  }
}

function failure(id: string, code: string, message: string): ShellCallResult {
  return { type: 'shell-result', id, ok: false, error: { code, message } }
}

/**
 * 给 host 进程挂上 `shell-call` 的处理。
 *
 * 与 `settleHostMessage` 并列挂在同一个 'message' 事件上：一个管正向回包，
 * 一个管反向调用。
 */
export function attachShellCapabilities(child: UtilityProcess): void {
  child.on('message', (message: unknown) => {
    void handleShellCall(message, (response) => {
      try {
        child.postMessage(response)
      } catch (error) {
        // 进程正在退出：回包送不出去是正常的，host 那边会超时
        logger.debug('Failed to send a shell result', { error })
      }
    })
  })
}
