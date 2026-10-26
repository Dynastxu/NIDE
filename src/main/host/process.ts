import fs from 'node:fs'
import path from 'node:path'
import {
  app,
  MessageChannelMain,
  utilityProcess,
  type UtilityProcess,
  type WebContents
} from 'electron'
import { loggerFor } from '../logger'
import { isHostStreamEvent } from '@shared/host-rpc'
import { attachShellCapabilities } from './capabilities'
import type { HostStreamEvent } from '@shared/host-rpc'

/**
 * Electron shell 侧的 host 进程管理（MVP）。
 *
 * 现在只做三件事：
 * 1. `utilityProcess.fork` 拉起 `packages/host/src/index.ts`；
 * 2. 等它回 `{ type: 'ready' }`；
 * 3. 退出时发 `{ type: 'shutdown' }`，超时再 kill。
 *
 * host 现在是**必需**的：文件 / 章节 / 图鉴 / 概述 / 配置的实现都在它里面，shell
 * 只保留项目列表、窗口、对话框与确认框。所以它在启动时无条件拉起，不再是开关。
 *
 * 打包：`electron-builder.yml` 明确不做 asar，并把 host 源码、boot / hello、共享层
 * 与 profiles 一起放进 app 根。所以 dev 与打包版走同一个入口路径；等 host 有编译
 * 产物之后，再把这里改成 `app.isPackaged` 分支与 asar。
 *
 * TODO:
 * - host 崩溃后的重启策略与退避
 * - 编译产物 + asar（那时 profile 需要改用包标识符）
 */

const logger = loggerFor('host-process')

let child: UtilityProcess | null = null
let readyPromise: Promise<void> | null = null

/** shell → host 的调用（`invokeHost`）等着回执的那些请求，按 id 索引 */
interface PendingHostCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const pendingCalls = new Map<string, PendingHostCall>()
let callSeq = 0

/**
 * 流式事件的订阅者（现在只有一个：AI 对话的转发层）。
 *
 * 返回退订函数：模块热替换 / 测试里要能摘掉，否则同一个事件会被转发多次。
 */
const streamListeners = new Set<(event: HostStreamEvent) => void>()

export function subscribeHostStream(listener: (event: HostStreamEvent) => void): () => void {
  streamListeners.add(listener)
  return () => {
    streamListeners.delete(listener)
  }
}

/** 把一条 host 回包交给等着的调用；流式事件先分发给订阅者，其余忽略 */
function settleHostMessage(message: unknown): void {
  if (!message || typeof message !== 'object') return

  if (isHostStreamEvent(message)) {
    for (const listener of streamListeners) listener(message)
    return
  }

  const data = message as {
    type?: string
    id?: string
    ok?: boolean
    result?: unknown
    error?: { code?: string; message?: string }
  }
  if (data.type !== 'rpc-result' || typeof data.id !== 'string') return

  const pending = pendingCalls.get(data.id)
  if (!pending) return

  pendingCalls.delete(data.id)
  clearTimeout(pending.timer)

  if (data.ok) {
    pending.resolve(data.result)
    return
  }

  const error = new Error(data.error?.message ?? 'host RPC failed') as Error & { code?: string }
  error.code = data.error?.code
  pending.reject(error)
}

/** host 退出时把所有等着的调用拒掉：它们的回执永远不会来 */
function rejectPendingCalls(error: Error): void {
  for (const pending of pendingCalls.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  pendingCalls.clear()
}

export interface StartHostOptions {
  profile?: string
  /** NIDE_HOME；省略时依次取 NIDE_HOME、userData/nide-home。 */
  home?: string
  /** 等待 ready 的上限。 */
  timeoutMs?: number
}

/**
 * host 入口。
 *
 * - 开发（`app.isPackaged === false`）：直接跑源码 `packages/host/src/index.ts`，
 *   Electron 自带的 Node 做类型剥离，改代码不用先构建；
 * - 打包版：跑编译产物 `out/host/packages/host/src/index.js`，并把
 *   `--dist-root` 指过去（profile 模板与 `{{NIDE_ROOT}}` 都在那边）。
 *
 * 找不到时只记一条错误：`startHost()` 接下来的失败会带着这条上下文，比一个孤零零的
 * spawn 错误容易查得多。
 */
export function resolveHostEntry(): string {
  const appRoot = app.getAppPath()
  const entry = app.isPackaged
    ? path.join(appRoot, 'out', 'host', 'packages', 'host', 'src', 'index.js')
    : path.join(appRoot, 'packages', 'host', 'src', 'index.ts')

  if (!fs.existsSync(entry)) {
    logger.error('host entry not found; the packaged app is missing out/host', { entry })
  }
  return entry
}

/** 打包版才有编译产物根；开发时返回 null，host 用源码树里的 profiles */
function resolveHostDistRoot(): string | null {
  return app.isPackaged ? path.join(app.getAppPath(), 'out', 'host') : null
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
  const distRoot = resolveHostDistRoot()
  const timeoutMs = options.timeoutMs ?? 15_000

  logger.info('starting host process', { entry, home, profile, distRoot })

  const proc = utilityProcess.fork(
    entry,
    [
      '--profile',
      profile,
      '--home',
      home,
      '--user-data',
      app.getPath('userData'),
      // 内置插件目录在 app 根下；dev 与打包版语义一致（见 resolveHostEntry）
      '--app-root',
      app.getAppPath(),
      // 编译产物根：打包版才传，host 用它找 profile 模板与 {{NIDE_ROOT}}
      ...(distRoot ? ['--dist-root', distRoot] : [])
    ],
    {
      serviceName: 'nide-host',
      stdio: 'pipe',
      cwd: app.getAppPath(),
      env: childEnv(home)
    }
  )
  child = proc

  // 父端口的回包：ready/pong 之外的 rpc-result 交给 invokeHost 的等待表
  proc.on('message', settleHostMessage)
  // 反向能力调用（shell-call）：host 请 shell 做 Electron 才有的那几件事
  attachShellCapabilities(proc)

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
    rejectPendingCalls(error instanceof Error ? error : new Error(String(error)))
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
    rejectPendingCalls(new Error(`host process exited (code=${String(code)})`))
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

/**
 * shell → host 的一次 RPC 调用。
 *
 * 走 shell 与 host 之间那条父端口（`utilityProcess.postMessage`），不是 renderer 的
 * 直连 port：调用方是主进程自己（例如新建项目时的 `config.initialize`），那时窗口
 * 可能还不存在。host 用同一张 `RpcRegistry` 分发，所以 namespace/method 与 renderer
 * 那一侧完全一样。
 *
 * 会先等 host ready；host 没起来就抛（调用方决定是降级还是报错）。
 */
export async function invokeHost<T = unknown>(
  namespace: string,
  method: string,
  args: unknown[] = [],
  timeoutMs = 10_000
): Promise<T> {
  await startHost()

  const proc = child
  if (!proc) throw new Error('host process is not running')

  const id = `shell-${++callSeq}`

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(id)
      reject(new Error(`${namespace}.${method} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    pendingCalls.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer
    })

    try {
      proc.postMessage({ type: 'rpc', id, namespace, method, args })
    } catch (error) {
      clearTimeout(timer)
      pendingCalls.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export async function stopHost(timeoutMs = 3_000): Promise<void> {
  const proc = child
  if (!proc) return

  child = null
  readyPromise = null
  rejectPendingCalls(new Error('host process is stopping'))
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
