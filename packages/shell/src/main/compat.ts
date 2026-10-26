import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { loggerFor } from './logger'

/**
 * 兼容性开关（显卡 / Chromium 沙箱）。
 *
 * 起因是一个真实故障：某些机器上 GPU 子进程根本起不来
 * （`gpu_process_host.cc: GPU process launch failed`，随后
 * `gpu_data_manager_impl_private.cc: GPU process isn't usable. Goodbye.`），
 * 浏览器进程在 0.2 秒内自杀 —— 而 host 进程握手要 ~0.4 秒，于表现上是
 * 「双击图标什么都没发生」。手动加 `--disable-gpu` 就能正常跑。
 *
 * 这不是我们代码的错，但用户不该知道这个开关。所以：
 * - 连续两次看到 GPU 进程 `launch-failed`，写一个**持久标记**，
 *   带 `--disable-gpu` 重启一次；之后每次启动都直接软件渲染；
 * - 标记在 `<userData>/compat/disable-gpu`，删掉它就恢复硬件加速；
 * - `NIDE_DISABLE_GPU=1` 直接生效，`NIDE_DISABLE_GPU=0` 可以临时压过标记（排查用）。
 *
 * 沙箱**不自动关**：关掉 Chromium 沙箱是安全决策，只能由用户显式要求
 * （`--no-sandbox` 或 `NIDE_NO_SANDBOX=1`）。GPU 走软件渲染没有这个顾虑。
 */

const COMPAT_DIR = 'compat'

/** 记录「这次会话里见过几次 GPU 启动失败」——不落盘，重启即清 */
let gpuFailures = 0
/** 已经排过一次重启就不再排，避免 GPU 一直失败时反复重启 */
let relaunchScheduled = false

function compatPath(name: string): string {
  return path.join(app.getPath('userData'), COMPAT_DIR, name)
}

function readMarker(name: string): boolean {
  try {
    return fs.existsSync(compatPath(name))
  } catch {
    return false
  }
}

function writeMarker(name: string, content = '1'): void {
  try {
    const file = compatPath(name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${content}\n`, 'utf-8')
  } catch {
    // 写不进去只影响「下次还失败」；本次会话的兜底仍然有效
  }
}

/**
 * 应用兼容性开关。**必须在 app ready 之前调用**：
 * `disableHardwareAcceleration()` 只在 ready 前生效，ready 之后再调是空操作。
 */
export function applyCompatibilitySwitches(): void {
  const logger = loggerFor('compat')

  const env = process.env.NIDE_DISABLE_GPU
  const marker = readMarker('disable-gpu')
  const disableGpu = env === '1' || (marker && env !== '0')

  if (disableGpu) {
    app.disableHardwareAcceleration()
    logger.warn('Hardware acceleration disabled', {
      reason: env === '1' ? 'NIDE_DISABLE_GPU' : 'previous GPU launch failure'
    })
  }

  if (process.env.NIDE_NO_SANDBOX === '1') {
    // 只有在用户明确要求时才关：这是安全边界
    app.commandLine.appendSwitch('no-sandbox')
    logger.warn('Chromium sandbox disabled by NIDE_NO_SANDBOX')
  }
}

/**
 * GPU 子进程失败的处理。
 *
 * `child-process-gone` 在浏览器进程还活着时才会送到；这台机器上 GPU 失败后
 * 浏览器进程会立刻 FATAL，所以这条路**不保证**能跑到 —— 它只是尽力而为：
 * 能跑到就记一笔，连续两次就把标记写下来，让**下一次**启动直接软件渲染。
 *
 * 同时把「为什么 GPU 起不来」记进日志，省得以后又从头查。
 */
export function noteChildProcessGone(details: Electron.Details): void {
  if (details.type !== 'GPU') return

  const logger = loggerFor('compat')
  const failed = details.reason === 'launch-failed' || details.reason === 'crashed'
  if (!failed) return

  gpuFailures += 1
  writeMarker('gpu-failure-count', String(gpuFailures))
  logger.warn('GPU process failed', {
    reason: details.reason,
    exitCode: details.exitCode,
    count: gpuFailures
  })

  if (gpuFailures < 2 || relaunchScheduled) return

  relaunchScheduled = true
  writeMarker('disable-gpu')
  logger.warn('GPU failed twice; relaunching with --disable-gpu')

  /**
   * 带着禁用标记重启：`applyCompatibilitySwitches()` 会在下一次启动早于 ready
   * 关掉硬件加速。用 `app.quit()` 而不是 `process.exit()`，让 will-quit 里的
   * host 收尾逻辑跑一遍。
   */
  app.relaunch({ args: [...process.argv.slice(1), '--disable-gpu'] })
  app.quit()
}
