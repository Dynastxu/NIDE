import fs from 'node:fs'
import os from 'node:os'
import { fork } from 'node:child_process'
import type { PluginManager } from '../plugins.ts'
import type { PluginPermissionGuard } from '../permissions.ts'
import { pluginStorageFile } from '../storage.ts'
import type { HostToWorker, WorkerToHost } from './protocol.ts'
import { buildBackendFlags, resolveWorkerEntry } from './runtime.ts'

/**
 * 卸载脚本（`manifest.uninstall`）。
 *
 * 在插件停用之后、目录删除之前跑一次。与插件后端一样在**子进程**里执行：
 * 宿主不 import 插件代码，脚本拿到的权限与后端一致（`standalone` 不特殊）。
 *
 * 失败不吞：调用方据此中止删除（dev 里冒烟验证过「目录还在、脚本报错」比
 * 「目录删了、外部文件没清」容易恢复）。
 */

export const UNINSTALL_TIMEOUT_MS = 10_000

function readStorage(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export interface RunUninstallOptions {
  manager: PluginManager
  permissions: PluginPermissionGuard
  pluginId: string
  userDataDir: string
  home: string
  workerEntry?: string
  timeoutMs?: number
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export async function runUninstallScript(options: RunUninstallOptions): Promise<void> {
  const entry = options.manager.uninstallEntryOf(options.pluginId)
  if (!entry) return

  const location = options.manager.locationOf(options.pluginId)
  const plugin = options.manager.pluginOf(options.pluginId)
  const resolved = options.permissions.resolvedFor(options.pluginId)
  if (!location || !plugin || !resolved) throw new Error('插件信息不完整，无法执行卸载脚本')

  const workerEntry = options.workerEntry ?? resolveWorkerEntry()
  const flags = buildBackendFlags({
    trust: plugin.permissions.trust,
    permissions: resolved,
    workerEntry,
    pluginDir: location.dirPath
  })

  const storageFile = pluginStorageFile(options.userDataDir, options.pluginId)
  const timeoutMs = options.timeoutMs ?? UNINSTALL_TIMEOUT_MS

  const child = fork(workerEntry, [], {
    execArgv: flags,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  })

  child.stdout?.on('data', (chunk: Buffer) => {
    options.log?.('info', chunk.toString('utf8').trimEnd())
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    options.log?.('warn', chunk.toString('utf8').trimEnd())
  })

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      finish(new Error(`卸载脚本超时（${timeoutMs}ms）`))
    }, timeoutMs)
    timer.unref?.()

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!child.killed) child.kill()
      if (error) reject(error)
      else resolve()
    }

    child.on('message', (message: WorkerToHost) => {
      if (message.t === 'log') options.log?.(message.level, message.message)
      else if (message.t === 'uninstall-result') {
        if (message.ok) finish()
        else finish(new Error(message.error))
      }
    })
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      if (code === 0) return
      finish(new Error(`卸载脚本进程退出（code=${String(code)}）`))
    })

    const payload: HostToWorker = {
      t: 'uninstall',
      pluginId: options.pluginId,
      entry,
      paths: {
        userData: options.userDataDir,
        pluginDir: location.dirPath,
        temp: os.tmpdir(),
        home: options.home
      },
      storageFile,
      storage: readStorage(storageFile)
    }

    try {
      child.send(payload)
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
