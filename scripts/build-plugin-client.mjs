/**
 * 构建插件的浏览器半 bundle（方案 A）。
 *
 *   node scripts/build-plugin-client.mjs            # 构建所有声明了 client 的内置插件
 *   node scripts/build-plugin-client.mjs --only demo
 * 产物：`<插件目录>/<manifest.client.bundle>`（IIFE，默认 `dist/client.js`）。
 *
 * 约定（与 docs/architecture/plugin-ui-bundles.md 一致）：
 * - 入口固定是插件目录下的 `src/ui/client-entry.tsx`；
 * - React / ReactDOM 外置，运行时由宿主挂在 window 上；
 * - 用 classic JSX（React.createElement），避免 react/jsx-runtime 的全局问题；
 * - 加载时调用 window.__NIDE_REGISTER__(viewId, Component)。
 *
 * 哪些插件要构建由 manifest 自己说：只有 `client: { platform: 'web', bundle }` 的
 * 才进来。没有 `client` 的插件（纯数据 / 语言包）跳过，不会凭空生成产物。
 */
/* eslint-disable @typescript-eslint/explicit-function-return-type -- 纯 JS 构建脚本，签名写在 JSDoc 里 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { build } from 'vite'

const root = process.cwd()
const builtinDir = path.join(root, 'plugins', 'builtin')

/** `--only <dir>`：只构建一个插件（开发时迭代用） */
function readOnlyFilter(argv) {
  const index = argv.indexOf('--only')
  return index >= 0 ? (argv[index + 1] ?? null) : null
}

/** UMD/IIFE 的全局名必须是合法标识符：把目录名收敛成 PascalCase */
function globalNameFor(dir) {
  const cleaned = dir.replace(/[^a-zA-Z0-9]+/g, ' ').trim()
  const pascal = cleaned
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')

  return `NidePlugin${pascal || 'Bundle'}`
}

function targets() {
  if (!fs.existsSync(builtinDir)) return []

  const only = readOnlyFilter(process.argv.slice(2))
  const found = []

  for (const dir of fs.readdirSync(builtinDir)) {
    if (only && dir !== only) continue

    const pluginDir = path.join(builtinDir, dir)
    const manifestPath = path.join(pluginDir, 'manifest.json')
    if (!fs.existsSync(manifestPath)) continue

    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    } catch (error) {
      console.error(`[build-plugin-client] bad manifest: ${manifestPath}`, error)
      continue
    }

    const client = manifest?.client
    if (!client || client.platform !== 'web' || typeof client.bundle !== 'string') continue

    found.push({ dir, pluginDir, bundle: client.bundle })
  }

  return found
}

const jobs = targets()

if (jobs.length === 0) {
  console.warn('[build-plugin-client] no plugin declares a client bundle, nothing to do')
  process.exit(0)
}

for (const job of jobs) {
  const entry = path.join(job.pluginDir, 'src', 'ui', 'client-entry.tsx')
  if (!fs.existsSync(entry)) {
    console.error(`[build-plugin-client] missing entry, skipped: ${entry}`)
    continue
  }

  const outFile = path.join(job.pluginDir, job.bundle)
  console.log(`[build-plugin-client] building ${job.dir} -> ${path.relative(root, outFile)}`)

  await build({
    configFile: false,
    root,
    logLevel: 'info',
    resolve: {
      /*
       * 与 electron.vite.config.ts 的 renderer 别名保持一致。
       *
       * 插件 UI 会 import `@nide/client-kit/...` 这类包内路径，所以子路径必须用正则
       * 接住（字符串别名会把 `pkg/sub` 拼成 `index.ts/sub`）。
       */
      alias: [
        {
          find: /^@nide\/client-kit\//,
          replacement: `${path.resolve(root, 'packages/client-kit/src')}/`
        },
        {
          find: /^@nide\/client-ui-settings\//,
          replacement: `${path.resolve(root, 'packages/client-ui-settings/src')}/`
        },
        { find: '@renderer', replacement: path.resolve(root, 'src/renderer/src') },
        { find: '@shared', replacement: path.resolve(root, 'src/shared') }
      ]
    },
    esbuild: {
      jsx: 'transform',
      jsxFactory: 'React.createElement',
      jsxFragment: 'React.Fragment'
    },
    build: {
      // 产物落到 manifest 声明的位置；不清空目录 —— bundle 有可能被声明在插件根上，
      // 清空会把插件源码一起删掉
      outDir: path.dirname(outFile),
      emptyOutDir: false,
      minify: false,
      lib: {
        entry,
        formats: ['iife'],
        name: globalNameFor(job.dir),
        fileName: () => path.basename(outFile)
      },
      rollupOptions: {
        external: ['react', 'react-dom'],
        output: {
          globals: {
            react: 'React',
            'react-dom': 'ReactDOM'
          },
          extend: true
        }
      }
    }
  })
}
