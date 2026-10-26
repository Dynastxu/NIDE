import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { reactClickToComponent } from 'vite-plugin-react-click-to-component'

// 注意：Vite 不读 tsconfig 的 paths，@nide/contracts 必须在每个环境里显式声明别名
// main 与 preload 的依赖外置由 v5 的 build.externalizeDeps 默认启用，无需注册 externalizeDepsPlugin
const shared = resolve('packages/contracts/src')
const projectRoot = resolve('.')

export default defineConfig({
  main: {
    resolve: { alias: { '@nide/contracts': shared } },
    // 主进程与预加载都在 packages/shell（Electron 外壳）；渲染进程只有引导壳
    build: {
      rollupOptions: { input: resolve('packages/shell/src/main/index.ts') }
    }
  },
  preload: {
    resolve: { alias: { '@nide/contracts': shared } },
    build: {
      rollupOptions: { input: resolve('packages/shell/src/preload/index.ts') }
    }
  },
  renderer: {
    /**
     * 渲染进程的根是 `apps/desktop/renderer`（index.html 与 src 都在里面）。
     *
     * electron-vite 默认去 `src/renderer` 找；搬走之后必须显式指出来，否则它
     * 会打不开 index.html。
     */
    root: resolve('apps/desktop/renderer'),
    /*
     * electron-vite 只在**默认**的 `src/renderer/index.html` 存在时才自动填
     * `rollupOptions.input`；根目录搬走之后必须显式给，否则它会先警告
     * 「index.html file is not found in /src/renderer」，再抛
     * `build.rollupOptions.input option is required`。
     */
    build: {
      rollupOptions: { input: resolve('apps/desktop/renderer/index.html') }
    },
    resolve: {
      /*
       * 数组形式：子路径的正则别名要排在精确别名**前面**。
       *
       * 字符串别名在 rollup 里是「精确匹配或前缀 + '/'」——所以
       * `'@nide/client-ui-settings' -> src/index.ts` 会把
       * `@nide/client-ui-settings/PluginsBrowser` 错误地拼成
       * `.../index.ts/PluginsBrowser`。子路径必须先用正则接住。
       */
      alias: [
        { find: /^@nide\/client-kit\//, replacement: `${resolve('packages/client-kit/src')}/` },
        {
          find: /^@nide\/client-ui-main\//,
          replacement: `${resolve('packages/client-ui-main/src')}/`
        },
        {
          find: /^@nide\/client-ui-settings\//,
          replacement: `${resolve('packages/client-ui-settings/src')}/`
        },
        {
          find: /^@nide\/client-ui-welcome\//,
          replacement: `${resolve('packages/client-ui-welcome/src')}/`
        },
        { find: '@nide/contracts', replacement: shared },
        { find: '@nide/client-kit', replacement: resolve('packages/client-kit/src') },
        {
          find: '@nide/client-runtime',
          replacement: resolve('packages/client-runtime/src/index.ts')
        },
        {
          find: '@nide/client-modules',
          replacement: resolve('packages/client-modules/src/index.ts')
        },
        {
          find: '@nide/client-ui-slots',
          replacement: resolve('packages/client-ui-slots/src/index.ts')
        },
        {
          find: '@nide/client-ui-main',
          replacement: resolve('packages/client-ui-main/src/index.ts')
        },
        {
          find: '@nide/client-ui-layout',
          replacement: resolve('packages/client-ui-layout/src/index.tsx')
        },
        {
          find: '@nide/client-ui-settings',
          replacement: resolve('packages/client-ui-settings/src/index.ts')
        },
        {
          find: '@nide/client-ui-welcome',
          replacement: resolve('packages/client-ui-welcome/src/index.ts')
        },
        {
          find: '@nide/client-ui-renderer',
          replacement: resolve('packages/client-ui-renderer/src/index.tsx')
        }
      ]
    },
    plugins: [tailwindcss(), react(), reactClickToComponent()],
    server: {
      // 插件 UI 在 plugins/builtin/<dir>/src/ui/ 下，位于 renderer root(apps/desktop/renderer) 之外，
      // 显式放进 dev 文件白名单，避免 /@fs/ 请求被 Vite 拦截。
      //
      // 用户安装的第三方插件在 userData 下（更在 projectRoot 之外），它们的 client
      // bundle 也走 /@fs/：strict 关掉，否则新装的 UI 插件加载不了。dev-only；生产
      // 会换成 app 协议。
      fs: { allow: [projectRoot], strict: false }
    }
  }
})
