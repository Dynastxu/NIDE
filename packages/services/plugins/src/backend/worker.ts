import { pathToFileURL } from 'node:url'
import type {
  PluginBackend,
  PluginBackendHost,
  PluginBackendPaths
} from '../../../../contracts/src/plugin-api/backend.ts'
import type { BootstrapMessage, HostToWorker, WorkerToHost } from './protocol.ts'

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
  process.send?.(message)
}

interface BackendState {
  host: PluginBackendHost | null
  deactivate: (() => unknown | Promise<unknown>) | null
  handlers: Map<string, (params?: unknown) => unknown | Promise<unknown>>
  stopping: boolean
}

const state: BackendState = {
  host: null,
  deactivate: null,
  handlers: new Map(),
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

function createHost(pluginId: string, paths: PluginBackendPaths): PluginBackendHost {
  return {
    id: pluginId,
    paths,
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
  state.host = createHost(message.pluginId, message.paths)

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

  state.handlers.clear()
  send({ t: 'disposed' })
  // 让最后一帧 IPC 发出去再退出
  setTimeout(() => process.exit(0), 30)
}

process.on('message', (message: HostToWorker) => {
  if (message.t === 'bootstrap') void bootstrap(message)
  else if (message.t === 'invoke') void invoke(message)
  else if (message.t === 'dispose') void dispose()
})

process.on('uncaughtException', (error) => {
  send({ t: 'log', level: 'error', message: `未捕获异常：${error.message}` })
})

process.on('unhandledRejection', (reason) => {
  send({ t: 'log', level: 'error', message: `未处理的 Promise 拒绝：${String(reason)}` })
})
