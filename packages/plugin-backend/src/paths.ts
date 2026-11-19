import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ResolvedPermissions } from '../../contracts/src/plugin-api/permissions.ts'

/**
 * 后端子进程的**路径与启动参数**。
 *
 * 单独一个模块，是因为 runtime（拉起子进程）和 uninstall（卸载脚本也走子进程）
 * 都要用它；放进 runtime 会让两边互相 import。这里只有纯函数与 node:fs 探测，
 * 不持有任何状态。
 */

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
    // worker 自己会 import 同目录的 `protocol.js` / `storage-value.js`：只放行
    // `worker.js` 一个文件的话，第二个模块就是 EACCES（Node 的权限模型按文件算）
    path.dirname(options.workerEntry),
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
