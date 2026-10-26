/**
 * 纯 Node 的 host IPC 冒烟脚本。
 *
 *   node scripts/host-ipc-node-smoke.mts
 *
 * 不依赖 Electron，验证同一套 ready / ping / pong / shutdown 协议。
 * Electron 里的等价脚本是 scripts/host-ipc-smoke.cjs。
 *
 * 用 `.mts` 而不是 `.mjs`：仓库的 lint 把 `@typescript-eslint/explicit-function-return-type`
 * 应用到了脚本上，纯 JS 给不出返回类型注解，`pnpm ci` 就会因为这两条 error 直接失败。
 */
import { fork } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

interface HostMessage {
  type?: string
  id?: string
  [key: string]: unknown
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(repoRoot, 'packages', 'host', 'src', 'index.ts')
const home = path.join(repoRoot, '.nide-dev')

const child = fork(entry, ['--profile', 'desktop', '--home', home, '--reset'], {
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, NIDE_HOME: home }
})

child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(`[host] ${chunk}`))
child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[host:err] ${chunk}`))

function waitForMessage(type: string, timeoutMs: number): Promise<HostMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${type} timeout after ${timeoutMs}ms`)),
      timeoutMs
    )
    const onMessage = (message: HostMessage): void => {
      if (!message || message.type !== type) return
      clearTimeout(timer)
      child.off('message', onMessage)
      resolve(message)
    }
    child.on('message', onMessage)
  })
}

try {
  const ready = await waitForMessage('ready', 15_000)
  console.log('[smoke] ready:', ready)

  child.send({ type: 'ping', id: 'node-smoke-1' })
  console.log('[smoke] pong:', await waitForMessage('pong', 5_000))

  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.send({ type: 'shutdown' })
  console.log('[smoke] host exit:', await exited)
} catch (error) {
  console.error('[smoke] failed:', error)
  child.kill()
  process.exitCode = 1
}
