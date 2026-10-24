import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)

let installPath
try {
  installPath = require.resolve('electron/install.js')
} catch {
  console.warn('[install-electron] 未找到 electron/install.js，跳过')
  process.exit(0)
}

// 强制注入镜像环境变量，确保 @electron/get 一定能读到
const env = {
  ...process.env,
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/'
}

const result = spawnSync(process.execPath, [installPath], {
  stdio: 'inherit',
  env // 使用注入后的环境变量
})

if (result.status !== 0) {
  console.error('[install-electron] Electron 二进制安装失败')
  process.exit(result.status ?? 1)
}

console.log('[install-electron] 完成')
