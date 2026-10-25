import path from 'node:path'
import {
  app,
  MessageChannelMain,
  utilityProcess,
  type UtilityProcess,
  type WebContents
} from 'electron'
import { loggerFor } from '../logger'

/**
 * Electron shell 侧的 host 进程管理（MVP）。
 *
 * 现在只做三件事：
 * 1. `utilityProcess.fork` 拉起 `packages/host/src/index.ts`；
 * 2. 等它回 `{ type: 'ready' }`；
 * 3. 退出时发 `{ type: 'shutdown' }`，超时再 kill。
 *
 * 用 `NIDE_HOST=1` 打开，默认关闭 —— 在它稳定之前不影响现有启动链路。
 *
 * TODO:
 * - 打包后的入口：`app.isPackaged` 时用 resources 里的已编译 host，而不是 .ts
 * - host 崩溃后的重启策略与退避
 * - renderer ↔ host 的 MessagePort 转发
 */

const logger = loggerFor('host-process')

let child: UtilityProcess | null = null
let readyPromise: Promise<void> | null = null

export function isHostProcessEnabled(): boolean {
  return process.env.NIDE_HOST === '1'
}

export interface StartHostOptions {
  profile?: string
  /** NIDE_HOME；省略时依次取 NIDE_HOME、userData/nide-home。 */
  home?: string
  /** 等待 ready 的上限。 */
  timeoutMs?: number
}

/** dev：app.getAppPath() 是仓库根。打包后的路径在 TODO 里处理。 */
export function resolveHostEntry(): string {
  return path.join(app.getAppPath(), 'packages', 'host', 'src', 'index.ts')
}

function resolveHostHome(explicit?: string): string {
  const fromOption = explicit ?? process.env.NIDE_HOME
  if (fromOption && fromOption.trim().length > 0) return path.resolve(fromOption)
  return path.join(app.getPath('userData'), 'nide-home')
}

function childEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  env.NIDE_HOME = home
  return env
}

export function startHost(options: StartHostOptions = {}): Promise<void> {
  if (child) return readyPromise ?? Promise.resolve()
  if (readyPromise) return readyPromise

  const home = resolveHostHome(options.home)
  const profile = options.profile ?? process.env.NIDE_PROFILE ?? 'desktop'
  const entry = resolveHostEntry()
  const timeoutMs = options.timeoutMs ?? 15_000

  logger.info('starting host process', { entry, home, profile })

  const proc = utilityProcess.fork(
    entry,
    ['--profile', profile, '--home', home, '--user-data', app.getPath('userData')],
    {
      serviceName: 'nide-host',
      stdio: 'pipe',
      cwd: app.getAppPath(),
      env: childEnv(home)
    }
  )
  child = proc

  proc.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) logger.info(text)
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) logger.warn(text)
  })

  readyPromise = new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.off('message', onMessage)
      callback()
    }
    const onMessage = (message: unknown): void => {
      const data = message as { type?: string }
      if (data?.type === 'ready') finish(resolve)
    }
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`host ready timeout after ${timeoutMs}ms`)))
    }, timeoutMs)

    proc.on('message', onMessage)
    proc.once('exit', (code) => {
      finish(() => reject(new Error(`host exited before ready (code=${String(code)})`)))
    })
  }).catch((error) => {
    readyPromise = null
    logger.error('host process failed to become ready', { error })
    try {
      proc.kill()
    } catch {
      // 已经退出
    }
    throw error
  })

  proc.once('exit', (code) => {
    logger.info('host process exited', { code })
    child = null
    readyPromise = null
  })

  return readyPromise
}

/**
 * 给一个 renderer 挂 host 的直连 port。
 *
 * 建 `MessageChannelMain`：port1 交给 host，port2 交给 renderer，两个 port
 * 直接相连，后续 RPC 不经过 shell 转发。
 *
 * 调用方应在 `did-finish-load` 之后调用 —— 那时 preload 已经注册好接收器。
 */
export function attachHostPort(contents: WebContents, label: string): void {
  void startHost()
    .then(() => {
      if (!child || contents.isDestroyed()) return
      const { port1, port2 } = new MessageChannelMain()
      child.postMessage({ type: 'attach-port', label }, [port1])
      contents.postMessage('nide:host-port', { label }, [port2])
      logger.info('renderer port attached', { label })
    })
    .catch((error) => logger.warn('renderer port not attached', { error }))
}

export async function stopHost(timeoutMs = 3_000): Promise<void> {
  const proc = child
  if (!proc) return

  child = null
  readyPromise = null
  logger.info('stopping host process')

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } finally {
        finish()
      }
    }, timeoutMs)

    proc.once('exit', finish)
    try {
      proc.postMessage({ type: 'shutdown' })
    } catch {
      proc.kill()
      finish()
    }
  })
}
