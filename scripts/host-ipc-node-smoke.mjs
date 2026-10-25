/**
 * 纯 Node 的 host IPC 冒烟脚本。
 *
 *   node scripts/host-ipc-node-smoke.mjs
 *
 * 不依赖 Electron，验证同一套 ready / ping / pong / shutdown 协议。
 * Electron 里的等价脚本是 scripts/host-ipc-smoke.cjs。
 */
import { fork } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(repoRoot, 'packages', 'host', 'src', 'index.ts')
const home = path.join(repoRoot, '.nide-dev')

const child = fork(entry, ['--profile', 'desktop', '--home', home, '--reset'], {
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  env: { ...process.env, NIDE_HOME: home }
})

child.stdout?.on('data', (chunk) => process.stdout.write(`[host] ${chunk}`))
child.stderr?.on('data', (chunk) => process.stderr.write(`[host:err] ${chunk}`))

function waitForMessage(type, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${type} timeout after ${timeoutMs}ms`)),
      timeoutMs
    )
    const onMessage = (message) => {
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
