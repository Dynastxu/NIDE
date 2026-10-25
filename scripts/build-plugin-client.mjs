/**
 * 构建一个插件的浏览器半 bundle（方案 A）。
 *
 *   node scripts/build-plugin-client.mjs
 *
 * 产物：plugins/builtin/demo/dist/client.js（IIFE）。
 * - React / ReactDOM 外置，运行时由宿主挂在 window 上；
 * - 用 classic JSX（React.createElement），避免 react/jsx-runtime 的全局问题；
 * - 加载时调用 window.__NIDE_REGISTER__(viewId, Component)。
 *
 * 现在只硬编码 demo；等 nide.client 声明稳定后，这里改成遍历插件目录。
 */
import path from 'node:path'
import process from 'node:process'
import { build } from 'vite'

const root = process.cwd()

await build({
  configFile: false,
  root,
  logLevel: 'info',
  resolve: {
    alias: {
      '@renderer': path.resolve(root, 'src/renderer/src'),
      '@shared': path.resolve(root, 'src/shared')
    }
  },
  esbuild: {
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment'
  },
  build: {
    outDir: path.resolve(root, 'plugins/builtin/demo/dist'),
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: path.resolve(root, 'plugins/builtin/demo/src/ui/client-entry.tsx'),
      formats: ['iife'],
      name: 'NidePluginDemo',
      fileName: () => 'client.js'
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
