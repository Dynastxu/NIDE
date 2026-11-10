import { pathToFileURL } from 'node:url'
import type {
  PluginBackend,
  PluginBackendHost,
  PluginBackendPaths,
  PluginHostCapabilities,
  PluginStorageApi
} from '../../../../contracts/src/plugin-api/backend.ts'
import {
  STORAGE_FLUSH_MS,
  type BootstrapMessage,
  type HostToWorker,
  type WorkerToHost
} from './protocol.ts'

/**
 * 插件后端子进程的运行时。
 *
 * 这个文件是**子进程入口**（`fork` 的脚本），不 import 宿主实现：
 * - 建一个很小的 `host` 对象给插件（日志 / 注册方法 / 路径）；
 * - 用动态 `import()` 装载插件 `main`；
 * - 把 `invoke` 转成方法调用，`dispose` 转成 `deactivate`。
 *
 * 插件默认导出可以是 `{ activate, deactivate }`，也可以直接是一个函数
 * （等价于 `{ activate }`）；`activate` 返回函数时那个函数就是清理函数。
 */

function send(message: WorkerToHost): void {
  try {
    process.send?.(message)
  } catch {
    // 结构化克隆失败（例如插件往 storage 里塞了函数）不能让整个子进程崩掉
  }
}

interface BackendState {
  host: PluginBackendHost | null
  deactivate: (() => unknown | Promise<unknown>) | null
  handlers: Map<string, (params?: unknown) => unknown | Promise<unknown>>
  /** 把挂起的存储写入交给宿主；dispose 前必调 */
  flushStorage: (() => void) | null
  stopping: boolean
}

const state: BackendState = {
  host: null,
  deactivate: null,
  handlers: new Map(),
  flushStorage: null,
  stopping: false
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
}

function log(level: 'info' | 'warn' | 'error', message: string, args: unknown[]): void {
  send({
    t: 'log',
    level,
    message: args.length > 0 ? `${message} ${formatArgs(args)}` : message
  })
}

// ---------------------------------------------------------------------------
// 宿主能力：请求在子进程发起，真正执行在宿主（带权限检查）
// ---------------------------------------------------------------------------

const hostPending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>()
let hostSeq = 0

function hostCall<T>(method: string, args: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++hostSeq
    hostPending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    send({ t: 'host-call', id, method, args })
  })
}

function createCapabilities(): PluginHostCapabilities {
  return {
    openExternal: (url) => hostCall('openExternal', url),
    openPath: (target) => hostCall('openPath', target),
    showOpenDialog: (options) => hostCall('showOpenDialog', options),
    showSaveDialog: (options) => hostCall('showSaveDialog', options),
    readClipboard: () => hostCall('readClipboard', undefined),
    writeClipboard: (text) => hostCall('writeClipboard', text),
    notify: (options) => hostCall('notify', options)
  }
}

/**
 * 同步视图 + 合并写盘。
 *
 * 与 mics 的 RemoteStorageService 一致：`set` 立刻改内存，写入 100ms 合并后
 * 通过 `storage:set` / `storage:delete` 交给宿主；`flush` 在停用前必调。
 */
function createStorage(snapshot: Record<string, unknown>): {
  api: PluginStorageApi
  flush: () => void
} {
  const data = new Map<string, unknown>(Object.entries(snapshot))
  const pending = new Map<string, unknown>()
  const removed = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    for (const [key, value] of pending) send({ t: 'storage:set', key, value })
    for (const key of removed) send({ t: 'storage:delete', key })
    pending.clear()
    removed.clear()
  }

  const schedule = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      flush()
    }, STORAGE_FLUSH_MS)
    timer.unref?.()
  }

  return {
    api: {
      get<T>(key: string, fallback?: T): T | undefined {
        return data.has(key) ? (data.get(key) as T) : fallback
      },
      set(key, value) {
        data.set(key, value)
        pending.set(key, value)
        removed.delete(key)
        schedule()
      },
      delete(key) {
        if (!data.has(key)) return
        data.delete(key)
        pending.delete(key)
        removed.add(key)
        schedule()
      },
      keys: () => [...data.keys()]
    },
    flush
  }
}

function createHost(
  pluginId: string,
  paths: PluginBackendPaths,
  storage: PluginStorageApi,
  capabilities: PluginHostCapabilities
): PluginBackendHost {
  return {
    id: pluginId,
    paths,
    storage,
    host: capabilities,
    log: {
      info: (message, ...args) => log('info', message, args),
      warn: (message, ...args) => log('warn', message, args),
      error: (message, ...args) => log('error', message, args)
    },
    handle(method, handler) {
      if (state.handlers.has(method)) {
        throw new Error(`插件 ${pluginId} 重复注册方法 ${method}`)
      }
      state.handlers.set(method, handler)
      send({ t: 'register', method })

      return () => {
        if (!state.handlers.delete(method)) return
        send({ t: 'unregister', method })
      }
    }
  }
}

async function bootstrap(message: BootstrapMessage): Promise<void> {
  const storage = createStorage(message.storage ?? {})
  state.flushStorage = storage.flush
  state.host = createHost(message.pluginId, message.paths, storage.api, createCapabilities())

  let module: Record<string, unknown>
  try {
    module = (await import(pathToFileURL(message.entry).href)) as Record<string, unknown>
  } catch (error) {
    send({
      t: 'failed',
      stage: 'import',
      message: error instanceof Error ? error.message : String(error)
    })
    return
  }

  const candidate = (module.default ?? module) as
    PluginBackend | ((host: PluginBackendHost) => unknown)
  try {
    if (typeof candidate === 'function') {
      const cleanup = await candidate(state.host)
      if (typeof cleanup === 'function') state.deactivate = cleanup as () => unknown
    } else if (candidate && typeof candidate.activate === 'function') {
      const cleanup = await candidate.activate(state.host)
      state.deactivate =
        typeof cleanup === 'function'
          ? (cleanup as () => unknown)
          : typeof candidate.deactivate === 'function'
            ? () => candidate.deactivate?.()
            : null
    } else {
      send({
        t: 'failed',
        stage: 'activate',
        message: '插件 main 没有导出 activate(host)'
      })
      return
    }
  } catch (error) {
    send({
      t: 'failed',
      stage: 'activate',
      message: error instanceof Error ? error.message : String(error)
    })
    return
  }

  send({ t: 'ready', methods: [...state.handlers.keys()] })
}

async function invoke(message: Extract<HostToWorker, { t: 'invoke' }>): Promise<void> {
  try {
    const handler = state.handlers.get(message.method)
    if (!handler) throw new Error(`插件没有注册方法 ${message.method}`)
    const value = await handler(message.params)
    send({ t: 'result', id: message.id, ok: true, value })
  } catch (error) {
    send({
      t: 'result',
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

async function dispose(): Promise<void> {
  if (state.stopping) return
  state.stopping = true

  try {
    await state.deactivate?.()
  } catch (error) {
    log('warn', '插件 deactivate 抛错，已忽略', [error instanceof Error ? error.message : error])
  }

  // 清理里可能还会写 storage，所以先 dispose 再 flush
  state.flushStorage?.()
  state.handlers.clear()
  send({ t: 'disposed' })
  // 让最后一帧 IPC 发出去再退出
  setTimeout(() => process.exit(0), 30)
}

/**
 * 卸载脚本。
 *
 * 在插件停止之后、目录被删除之前跑一次，用来清理插件在目录外留下的东西。
 * 与后端本体一样在子进程里执行，宿主不会 import 插件代码。
 */
async function uninstall(message: Extract<HostToWorker, { t: 'uninstall' }>): Promise<void> {
  try {
    const module = (await import(
      `${pathToFileURL(message.entry).href}?nide-uninstall=${Date.now()}`
    )) as Record<string, unknown>

    const candidate = module.default ?? module.run
    if (typeof candidate !== 'function') throw new Error('卸载脚本需要默认导出函数')

    await candidate({
      id: message.pluginId,
      dir: message.paths.pluginDir,
      storageFile: message.storageFile,
      storage: message.storage,
      log: (text: string) => log('info', `[uninstall] ${text}`, [])
    })
    send({ t: 'uninstall-result', ok: true })
  } catch (error) {
    send({
      t: 'uninstall-result',
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    setTimeout(() => process.exit(0), 30)
  }
}

process.on('message', (message: HostToWorker) => {
  if (message.t === 'bootstrap') void bootstrap(message)
  else if (message.t === 'invoke') void invoke(message)
  else if (message.t === 'uninstall') void uninstall(message)
  else if (message.t === 'dispose') void dispose()
  else if (message.t === 'host-result') {
    const entry = hostPending.get(message.id)
    if (!entry) return
    hostPending.delete(message.id)
    if (message.ok) entry.resolve(message.value)
    else entry.reject(new Error(String(message.error)))
  }
})

process.on('uncaughtException', (error) => {
  send({ t: 'log', level: 'error', message: `未捕获异常：${error.message}` })
})

process.on('unhandledRejection', (reason) => {
  send({ t: 'log', level: 'error', message: `未处理的 Promise 拒绝：${String(reason)}` })
})
