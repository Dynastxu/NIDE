import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { reactClickToComponent } from 'vite-plugin-react-click-to-component'

// 注意：Vite 不读 tsconfig 的 paths，@shared 必须在每个环境里显式声明别名
// main 与 preload 的依赖外置由 v5 的 build.externalizeDeps 默认启用，无需注册 externalizeDepsPlugin
const shared = resolve('src/shared')
const projectRoot = resolve('.')

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } }
  },
  preload: {
    resolve: { alias: { '@shared': shared } }
  },
  renderer: {
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve('src/renderer/src'),
        '@nide/client-runtime': resolve('packages/client-runtime/src/index.ts'),
        '@nide/client-modules': resolve('packages/client-modules/src/index.ts'),
        '@nide/client-ui-slots': resolve('packages/client-ui-slots/src/index.ts'),
        '@nide/client-ui-main': resolve('packages/client-ui-main/src/index.ts'),
        '@nide/client-ui-layout': resolve('packages/client-ui-layout/src/index.tsx'),
        '@nide/client-ui-settings': resolve('packages/client-ui-settings/src/index.ts'),
        '@nide/client-ui-welcome': resolve('packages/client-ui-welcome/src/index.ts'),
        '@nide/client-ui-renderer': resolve('packages/client-ui-renderer/src/index.tsx')
      }
    },
    plugins: [tailwindcss(), react(), reactClickToComponent()],
    server: {
      // 插件 UI 在 plugins/builtin/<dir>/src/ui/ 下，位于 renderer root(src/renderer) 之外，
      // 显式放进 dev 文件白名单，避免 /@fs/ 请求被 Vite 拦截。
      //
      // 用户安装的第三方插件在 userData 下（更在 projectRoot 之外），它们的 client
      // bundle 也走 /@fs/：strict 关掉，否则新装的 UI 插件加载不了。dev-only；生产
      // 会换成 app 协议。
      fs: { allow: [projectRoot], strict: false }
    }
  }
})
