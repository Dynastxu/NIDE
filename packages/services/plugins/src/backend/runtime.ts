import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { PluginBackendPaths } from '../../../../contracts/src/plugin-api/backend.ts'
import type { ResolvedPermissions } from '../../../../contracts/src/plugin-api/permissions.ts'
import type { PluginManager } from '../plugins.ts'
import type { PluginPermissionGuard } from '../permissions.ts'
import type { PluginStorage } from '../storage.ts'
import type { PluginCapabilities } from '../capabilities.ts'
import type { HostToWorker, WorkerToHost } from './protocol.ts'

/**
 * 插件后端子进程的宿主侧（mics 的 PluginWorkerHost 对应物）。
 *
 * 只做四件事：
 * 1. 把权限声明翻成 Node 的 `--permission` 参数（`trust: 'full'` 不限制）；
 * 2. fork 子进程、等握手、把 RPC 转成进程消息；
 * 3. 插件启用 / 停用 / 卸载 / 重扫时同步起停；
 * 4. 崩溃只影响这个插件：状态转 failed，下一次调用会重新拉起。
 *
 * 进程边界是**真的**：`sandboxed` 插件的文件与子进程能力由 Node 引擎强制，
 * 不再依赖插件自觉走 SDK。
 */

export interface PluginBackendPathsOptions {
  userDataDir: string
  home: string
}

/** 子进程启动后多久没握手就判定失败 */
const READY_TIMEOUT_MS = 15_000
/** dispose 等子进程自己退出；超时直接 kill */
const DISPOSE_TIMEOUT_MS = 5_000

export interface BackendStatus {
  pluginId: string
  state: 'starting' | 'running' | 'stopped' | 'failed'
  methods: string[]
  error?: string
}

/** 启动时机是否为「随宿主启动」：`*` 或 `onStartup` */
export function isEagerActivation(activation: readonly string[]): boolean {
  return activation.includes('*') || activation.includes('onStartup')
}

export interface PluginBackendRuntimeOptions extends PluginBackendPathsOptions {
  manager: PluginManager
  permissions: PluginPermissionGuard
  /** 每插件命名空间的键值存储 */
  storage: PluginStorage
  /** 受权限检查的桌面能力 */
  capabilities: PluginCapabilities
  /** 覆盖 worker 入口（测试用）；默认按模块位置找同目录的 worker.js / worker.ts */
  workerEntry?: string
  log?: {
    info(message: string, fields?: Record<string, unknown>): void
    warn(message: string, fields?: Record<string, unknown>): void
    error(message: string, fields?: Record<string, unknown>): void
  }
}

/**
 * 把权限声明翻成 Node 的启动参数。
 *
 * 与 mics 一致：
 * - 只有 `sandboxed` 才加 `--permission`；`full` 不限制（老插件行为不变）；
 * - worker 自身与插件目录必须可读，否则 `import` 第一步就失败；
 * - 写作用域同时给 `--allow-fs-write`；
 * - 子进程权限是全有全无：声明了 `exec` 才放开 `--allow-child-process`。
 */
export function buildBackendFlags(options: {
  trust: 'full' | 'sandboxed'
  permissions: ResolvedPermissions
  workerEntry: string
  pluginDir: string
  runtimeReadPaths?: string[]
}): string[] {
  if (options.trust !== 'sandboxed') return []

  const read = new Set<string>([
    options.workerEntry,
    options.pluginDir,
    ...(options.runtimeReadPaths ?? []),
    ...options.permissions.fs.read.resolved,
    ...options.permissions.fs.meta.resolved,
    ...options.permissions.fs.write.resolved
  ])
  const write = new Set(options.permissions.fs.write.resolved)

  const flags = ['--permission']
  for (const entry of read) flags.push(`--allow-fs-read=${entry}`)
  for (const entry of write) flags.push(`--allow-fs-write=${entry}`)
  if (options.permissions.exec.length > 0) flags.push('--allow-child-process')
  return flags
}

/**
 * 按声明的可写目录预建目录。
 *
 * Node 的 `--allow-fs-write=<dir>` 只允许在 dir 里创建条目，**不包括创建 dir
 * 本身**；不预建的话插件第一次写 `${userData}/notes/x.md` 就会 EPERM。
 */
export function ensureWriteRoots(
  permissions: ResolvedPermissions,
  onError?: (dir: string, error: unknown) => void
): void {
  for (const dir of permissions.fs.write.resolved) {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (error) {
      onError?.(dir, error)
    }
  }
}

/** 默认的 worker 入口：编译产物是 `.js`，源码树是 `.ts` */
export function resolveWorkerEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  for (const name of ['worker.js', 'worker.ts']) {
    const candidate = path.join(here, name)
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(`plugin backend worker entry not found next to ${here}`)
}

export class PluginBackendRuntime {
  private readonly options: PluginBackendRuntimeOptions
  private readonly workers = new Map<string, BackendWorker>()
  private readonly starting = new Map<string, Promise<void>>()
  private readonly states = new Map<string, BackendStatus>()
  private readonly log: NonNullable<PluginBackendRuntimeOptions['log']>

  constructor(options: PluginBackendRuntimeOptions) {
    this.options = options
    this.log = options.log ?? {
      info: (message, fields) => console.info(`[nide-host] ${message}`, fields ?? ''),
      warn: (message, fields) => console.warn(`[nide-host] ${message}`, fields ?? ''),
      error: (message, fields) => console.error(`[nide-host] ${message}`, fields ?? '')
    }
  }

  /** 启动所有「已启用 + 有后端 + 声明了 onStartup / *」的插件 */
  async startEnabled(): Promise<void> {
    const plugins = this.options.manager.list().filter((plugin) => plugin.hasBackend)
    for (const plugin of plugins) {
      if (!this.options.manager.isEnabled(plugin.id)) continue
      if (!isEagerActivation(plugin.activation)) continue
      try {
        await this.ensure(plugin.id)
      } catch (error) {
        this.log.warn(`插件后端启动失败：${plugin.id}`, {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
  /** 重新扫描 / 安装 / 卸载之后对齐：停掉没有后端或已禁用的，拉起新启用的 */
  async reconcile(): Promise<void> {
    for (const pluginId of [...this.workers.keys()]) {
      const plugin = this.options.manager.list().find((item) => item.id === pluginId)
      if (!plugin || !plugin.hasBackend || !this.options.manager.isEnabled(pluginId)) {
        await this.stop(pluginId)
      }
    }
    await this.startEnabled()
  }

  /** 启用状态变化时由插件服务调用 */
  async handleEnabled(pluginId: string, enabled: boolean): Promise<void> {
    if (!enabled) {
      await this.stop(pluginId)
      return
    }
    if (!this.options.manager.backendEntryOf(pluginId)) return
    try {
      await this.ensure(pluginId)
    } catch (error) {
      this.log.warn(`插件后端启动失败：${pluginId}`, {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * 视图被打开时由插件服务调用：命中原插件声明的 `onView:<viewId>` 才激活后端。
   *
   * 没有声明的（含空 `activation`）按需激活，等第一次 `plugin.call`。
   */
  async activateForView(viewId: string): Promise<void> {
    const pluginId = this.options.manager.viewOwner(viewId)
    if (!pluginId) return

    const plugin = this.options.manager.pluginOf(pluginId)
    if (!plugin || !plugin.hasBackend || !this.options.manager.isEnabled(pluginId)) return
    if (!plugin.activation.includes(`onView:${viewId}`)) return

    try {
      await this.ensure(pluginId)
    } catch (error) {
      this.log.warn(`插件后端启动失败：${pluginId}`, {
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** 确保后端已启动；已启动则直接返回。`visited` 用来斩断循环依赖 */
  async ensure(pluginId: string, visited = new Set<string>()): Promise<void> {
    if (visited.has(pluginId)) return
    visited.add(pluginId)

    try {
      await this.activateDependencies(pluginId, visited)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.setState(pluginId, 'failed', [], message)
      throw error
    }

    if (this.workers.has(pluginId)) return

    const pending = this.starting.get(pluginId)
    if (pending) {
      await pending
      return
    }

    const task = this.start(pluginId).then(() => undefined)
    this.starting.set(pluginId, task)
    try {
      await task
    } finally {
      this.starting.delete(pluginId)
    }
  }

  /** 先激活依赖。依赖没装 / 被禁用时整次启动失败（与 mics 的拓扑激活一致） */
  private async activateDependencies(pluginId: string, visited: Set<string>): Promise<void> {
    const plugin = this.options.manager.pluginOf(pluginId)
    if (!plugin) return

    for (const dependency of plugin.dependencies) {
      const target = this.options.manager.pluginOf(dependency)
      if (!target) {
        throw new Error(`缺少依赖插件 ${dependency}（被 ${pluginId} 依赖）`)
      }
      if (!this.options.manager.isEnabled(dependency)) {
        throw new Error(`依赖插件 ${dependency} 已被禁用（被 ${pluginId} 依赖）`)
      }
      if (!target.hasBackend) continue
      await this.ensure(dependency, visited)
    }
  }

  /** 调用插件后端方法；后端没起来时先拉起（懒启动） */
  async invoke(pluginId: string, method: string, params?: unknown): Promise<unknown> {
    const plugin = this.options.manager.list().find((item) => item.id === pluginId)
    if (!plugin) throw new Error(`插件 ${pluginId} 不在清单里`)
    if (!plugin.hasBackend) throw new Error(`插件 ${pluginId} 没有后端（manifest.main）`)
    if (!this.options.manager.isEnabled(pluginId)) throw new Error(`插件 ${pluginId} 已被禁用`)

    await this.ensure(pluginId)
    const worker = this.workers.get(pluginId)
    if (!worker) throw new Error(`插件 ${pluginId} 的后端没有启动`)
    return await worker.invoke(method, params)
  }

  /** 停止一个插件的后端；不存在时是空操作 */
  async stop(pluginId: string): Promise<void> {
    const pending = this.starting.get(pluginId)
    if (pending) {
      try {
        await pending
      } catch {
        // 启动已经失败，没有可停的进程
      }
    }

    const worker = this.workers.get(pluginId)
    if (!worker) {
      if (this.states.get(pluginId)?.state === 'running') {
        this.setState(pluginId, 'stopped', [])
      }
      return
    }

    this.workers.delete(pluginId)
    await worker.dispose()
    this.options.storage.flush(pluginId)
    this.setState(pluginId, 'stopped', [])
  }

  /** 宿主退出时调用：停掉所有后端 */
  async stopAll(): Promise<void> {
    for (const pluginId of [...this.workers.keys()]) {
      await this.stop(pluginId)
    }
  }

  status(): BackendStatus[] {
    const ids = new Set<string>()
    for (const plugin of this.options.manager.list()) {
      if (plugin.hasBackend) ids.add(plugin.id)
    }
    for (const id of this.states.keys()) ids.add(id)

    return [...ids]
      .sort()
      .map((pluginId) => this.states.get(pluginId) ?? { pluginId, state: 'stopped', methods: [] })
  }

  /** 自己记的路径：给 worker 的 `ctx.host.paths` 用 */
  pathsFor(pluginId: string): PluginBackendPaths {
    const location = this.options.manager.locationOf(pluginId)
    return {
      userData: this.options.userDataDir,
      pluginDir: location?.dirPath ?? '',
      temp: os.tmpdir(),
      home: this.options.home
    }
  }

  private async start(pluginId: string): Promise<BackendWorker> {
    const entry = this.options.manager.backendEntryOf(pluginId)
    if (!entry) throw new Error(`插件 ${pluginId} 没有后端入口`)
    if (!this.options.manager.isEnabled(pluginId)) throw new Error(`插件 ${pluginId} 已被禁用`)

    const plugin = this.options.manager.permissionsOf(pluginId)
    if (!plugin) throw new Error(`插件 ${pluginId} 不在清单里`)
    const resolved = this.options.permissions.resolvedFor(pluginId)
    if (!resolved) throw new Error(`插件 ${pluginId} 没有权限声明`)

    const workerEntry = this.options.workerEntry ?? resolveWorkerEntry()
    const location = this.options.manager.locationOf(pluginId)
    const pluginDir = location?.dirPath ?? path.dirname(entry)

    ensureWriteRoots(resolved, (dir, error) => {
      this.log.warn(`创建可写目录失败：${dir}`, { error: String(error) })
    })

    this.setState(pluginId, 'starting', [])

    let worker: BackendWorker
    try {
      worker = await BackendWorker.start({
        pluginId,
        entry,
        workerEntry,
        pluginDir,
        paths: this.pathsFor(pluginId),
        trust: plugin.trust,
        permissions: resolved,
        storage: this.options.storage.snapshot(pluginId),
        onStorageSet: (key, value) => this.options.storage.set(pluginId, key, value),
        onStorageDelete: (key) => this.options.storage.delete(pluginId, key),
        onHostCall: (method, args) => this.dispatchHostCall(pluginId, method, args),
        onLog: (level, message) => {
          if (level === 'error') this.log.error(`[plugin:${pluginId}] ${message}`)
          else if (level === 'warn') this.log.warn(`[plugin:${pluginId}] ${message}`)
          else this.log.info(`[plugin:${pluginId}] ${message}`)
        },
        onExit: (code) => {
          this.workers.delete(pluginId)
          const current = this.states.get(pluginId)
          if (current?.state !== 'stopped') {
            this.setState(pluginId, 'failed', [], `后端进程退出（code=${String(code)}）`)
            this.log.warn(`插件后端已退出：${pluginId}`, { code })
          }
        }
      })
    } catch (error) {
      this.setState(pluginId, 'failed', [], error instanceof Error ? error.message : String(error))
      throw error
    }

    this.workers.set(pluginId, worker)
    this.setState(pluginId, 'running', worker.methods())
    this.log.info(`插件后端已启动：${pluginId}`, {
      methods: worker.methods().length,
      trust: plugin.trust
    })
    return worker
  }

  /**
   * 子进程请求的桌面能力：按插件权限检查后交给 shell。
   *
   * 方法名是 worker 侧 `ctx.host` 的固定集合，不转发任意方法 —— 与反向桥的
   * 白名单是两层，缺一不可。
   */
  private async dispatchHostCall(
    pluginId: string,
    method: string,
    args: unknown
  ): Promise<unknown> {
    const capabilities = this.options.capabilities

    switch (method) {
      case 'openExternal':
        await capabilities.openExternal(pluginId, String(args ?? ''))
        return null
      case 'openPath':
        await capabilities.openPath(pluginId, String(args ?? ''))
        return null
      case 'showOpenDialog':
        return await capabilities.showOpenDialog(pluginId, args as never)
      case 'showSaveDialog':
        return await capabilities.showSaveDialog(pluginId, args as never)
      case 'readClipboard':
        return await capabilities.readClipboard(pluginId)
      case 'writeClipboard':
        await capabilities.writeClipboard(pluginId, String(args ?? ''))
        return null
      case 'notify':
        await capabilities.notify(pluginId, (args ?? {}) as never)
        return null
      default:
        throw new Error(`插件能力 ${method} 不存在`)
    }
  }

  private setState(
    pluginId: string,
    state: BackendStatus['state'],
    methods: string[],
    error?: string
  ): void {
    this.states.set(pluginId, {
      pluginId,
      state,
      methods,
      ...(error ? { error } : {})
    })
  }
}

interface BackendWorkerOptions {
  pluginId: string
  entry: string
  workerEntry: string
  pluginDir: string
  paths: PluginBackendPaths
  trust: 'full' | 'sandboxed'
  permissions: ResolvedPermissions
  /** 启动时交给子进程的存储快照 */
  storage: Record<string, unknown>
  onStorageSet: (key: string, value: unknown) => void
  onStorageDelete: (key: string) => void
  /** 子进程请求桌面能力；宿主按权限检查后执行 */
  onHostCall: (method: string, args: unknown) => Promise<unknown>
  onLog: (level: 'info' | 'warn' | 'error', message: string) => void
  onExit: (code: number | null) => void
}

/** 一个子进程 + 一条 IPC 通道 */
class BackendWorker {
  private readonly options: BackendWorkerOptions
  private readonly child: ChildProcess
  private readonly ready: Promise<string[]>
  private readonly registered = new Set<string>()
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private seq = 0
  private disposed = false

  private constructor(
    options: BackendWorkerOptions,
    child: ChildProcess,
    ready: Promise<string[]>
  ) {
    this.options = options
    this.child = child
    this.ready = ready
  }

  static async start(options: BackendWorkerOptions): Promise<BackendWorker> {
    const flags = buildBackendFlags({
      trust: options.trust,
      permissions: options.permissions,
      workerEntry: options.workerEntry,
      pluginDir: options.pluginDir
    })

    const child = fork(options.workerEntry, [], {
      execArgv: flags,
      // 宿主在打包版里是 Electron 的 utilityProcess：让它以纯 Node 运行
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true
    })

    let resolveReady: (methods: string[]) => void = () => undefined
    let rejectReady: (error: Error) => void = () => undefined
    const ready = new Promise<string[]>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })

    const worker = new BackendWorker(options, child, ready)

    child.stdout?.on('data', (chunk: Buffer) => {
      options.onLog('info', chunk.toString('utf8').trimEnd())
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      options.onLog('warn', chunk.toString('utf8').trimEnd())
    })

    child.on('message', (message: WorkerToHost) =>
      worker.onMessage(message, resolveReady, rejectReady)
    )
    child.once('error', (error) => {
      rejectReady(error)
      worker.failAll(error)
    })
    child.once('exit', (code) => {
      rejectReady(new Error(`插件后端进程退出（code=${String(code)}）`))
      worker.failAll(new Error(`插件后端进程已退出（code=${String(code)}）`))
      options.onExit(code)
    })

    const timer = setTimeout(() => {
      rejectReady(new Error('插件后端启动超时'))
      child.kill()
    }, READY_TIMEOUT_MS)
    timer.unref?.()

    worker.post({
      t: 'bootstrap',
      pluginId: options.pluginId,
      entry: options.entry,
      paths: options.paths,
      storage: options.storage
    })

    try {
      await ready
    } finally {
      clearTimeout(timer)
    }

    return worker
  }

  methods(): string[] {
    return [...this.registered]
  }

  async invoke(method: string, params?: unknown): Promise<unknown> {
    if (this.disposed) throw new Error(`插件后端已停止`)
    await this.ready
    if (!this.registered.has(method)) throw new Error(`插件后端没有注册方法 ${method}`)

    return await new Promise<unknown>((resolve, reject) => {
      const id = ++this.seq
      this.pending.set(id, { resolve, reject })
      this.post({ t: 'invoke', id, method, params })
    })
  }

  private post(message: HostToWorker): void {
    if (!this.child.connected) return
    try {
      this.child.send(message)
    } catch {
      // 子进程刚好退出：调用方已经在 exit 里收到失败
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, DISPOSE_TIMEOUT_MS)
      timer.unref?.()
      this.child.once('message', (message: WorkerToHost) => {
        if (message.t !== 'disposed') return
        clearTimeout(timer)
        resolve()
      })
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })

    this.post({ t: 'dispose' })
    await done
    this.failAll(new Error('插件后端已停止'))
    this.child.kill()
  }

  private onMessage(
    message: WorkerToHost,
    resolveReady: (methods: string[]) => void,
    rejectReady: (error: Error) => void
  ): void {
    switch (message.t) {
      case 'ready':
        for (const method of message.methods) this.registered.add(method)
        resolveReady(message.methods)
        return
      case 'failed':
        rejectReady(new Error(`${message.stage}：${message.message}`))
        return
      case 'register':
        this.registered.add(message.method)
        return
      case 'unregister':
        this.registered.delete(message.method)
        return
      case 'result': {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        if (message.ok) entry.resolve(message.value)
        else entry.reject(new Error(message.error))
        return
      }
      case 'storage:set':
        this.options.onStorageSet(message.key, message.value)
        return
      case 'storage:delete':
        this.options.onStorageDelete(message.key)
        return
      case 'host-call':
        void this.handleHostCall(message)
        return
      case 'log':
        this.options.onLog(message.level, message.message)
        return
      case 'disposed':
        return
    }
  }

  private async handleHostCall(message: Extract<WorkerToHost, { t: 'host-call' }>): Promise<void> {
    try {
      const value = await this.options.onHostCall(message.method, message.args)
      this.post({ t: 'host-result', id: message.id, ok: true, value })
    } catch (error) {
      this.post({
        t: 'host-result',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }
}
