import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 注意：Vite 不读 tsconfig 的 paths，@shared 必须在每个环境里显式声明别名
const shared = resolve('src/shared')
const projectRoot = resolve('.')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } }
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [tailwindcss(), react()],
    server: {
      // 插件 UI 在 plugins/builtin/<dir>/src/ui/ 下，位于 renderer root(src/renderer) 之外，
      // 显式放进 dev 文件白名单，避免 /@fs/ 请求被 Vite 拦截
      fs: { allow: [projectRoot] }
    }
  }
})
