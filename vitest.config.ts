import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

/**
 * host 侧的包名 → 源码目录。
 *
 * test/host 直接跑在 Node 里，不经过 electron-vite；这些包现在用 `@nide/<包>`
 * 互相 import，所以测试也要能解析。顺序（子路径正则在前、精确匹配在后）与
 * electron.vite.config.ts 的 renderer 别名一致。
 */
const hostPackages: Record<string, string> = {
  '@nide/kernel': 'packages/kernel/src',
  '@nide/boot': 'packages/boot/src',
  '@nide/host': 'packages/host/src',
  '@nide/hello': 'packages/hello/src',
  '@nide/service-ai': 'packages/ai/src',
  '@nide/service-appearance': 'packages/appearance/src',
  '@nide/service-config': 'packages/config/src',
  '@nide/service-content': 'packages/content/src',
  '@nide/service-git': 'packages/git/src',
  '@nide/service-i18n': 'packages/i18n/src',
  '@nide/service-plugin-backend': 'packages/plugin-backend/src',
  '@nide/service-plugin-capabilities': 'packages/plugin-capabilities/src',
  '@nide/service-plugin-permissions': 'packages/plugin-permissions/src',
  '@nide/service-plugins': 'packages/plugin-runtime/src',
  '@nide/service-plugin-storage': 'packages/plugin-storage/src',
  '@nide/service-project': 'packages/project/src',
  '@nide/service-secrets': 'packages/secrets/src'
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const hostAliases = Object.entries(hostPackages).flatMap(([name, dir]) => [
  { find: new RegExp(`^${escapeRegExp(name)}/`), replacement: `${resolve(dir)}/` },
  { find: name, replacement: resolve(`${dir}/index.ts`) }
])

/**
 * 测试配置。
 *
 * 覆盖范围刻意只包括**不依赖 electron** 的纯逻辑：locale 归一化、语言包合并与
 * 优先级、manifest 的 %key% 解析、加载器对不可信输入的处理，以及仓库里本地化
 * 数据的一致性。渲染进程里也有一处（条目菜单项的装配，见 entry/entry-menu）——
 * 它同样被写成纯函数，所以能在这里跑。真正的集成面（窗口重建、原生菜单、
 * Monaco NLS、IPC）不在这里，那些得靠手动跑应用验证。
 *
 * 别名必须和 electron.vite.config.ts 保持一致：被测模块内部就用 '@nide/contracts/...'
 * 互相引用，少一个别名测试直接解析失败。
 */
export default defineConfig({
  resolve: {
    /*
     * 与 electron.vite.config.ts 同一条规则：子路径用正则接住，精确别名在后。
     * 测试只用到 kit 与 settings 的 pages（`test/renderer/**` 跟着被测代码走）。
     */
    alias: [
      ...hostAliases,
      // 所有子路径正则必须排在精确别名之前（字符串别名也会匹配 `pkg/sub`）
      { find: /^@nide\/shell\//, replacement: `${resolve('packages/shell/src')}/` },
      { find: /^@nide\/client-kit\//, replacement: `${resolve('packages/client-kit/src')}/` },
      { find: /^@nide\/sdk\//, replacement: `${resolve('packages/sdk/src')}/` },
      {
        find: /^@nide\/client-modules\//,
        replacement: `${resolve('packages/client-modules/src')}/`
      },
      {
        find: /^@nide\/client-runtime\//,
        replacement: `${resolve('packages/client-runtime/src')}/`
      },
      {
        find: /^@nide\/client-ui-main\//,
        replacement: `${resolve('packages/client-ui-main/src')}/`
      },
      {
        find: /^@nide\/client-ui-editor\//,
        replacement: `${resolve('packages/client-ui-editor/src')}/`
      },
      {
        find: /^@nide\/client-ui-explorer\//,
        replacement: `${resolve('packages/client-ui-explorer/src')}/`
      },
      {
        find: /^@nide\/client-ui-git\//,
        replacement: `${resolve('packages/client-ui-git/src')}/`
      },
      {
        find: /^@nide\/client-ui-settings\//,
        replacement: `${resolve('packages/client-ui-settings/src')}/`
      },
      {
        find: /^@nide\/client-ui-welcome\//,
        replacement: `${resolve('packages/client-ui-welcome/src')}/`
      },
      {
        find: /^@nide\/client-ui-plugins\//,
        replacement: `${resolve('packages/client-ui-plugins/src')}/`
      },
      {
        find: /^@nide\/client-ui-renderer\//,
        replacement: `${resolve('packages/client-ui-renderer/src')}/`
      },
      {
        find: /^@nide\/client-ui-slots\//,
        replacement: `${resolve('packages/client-ui-slots/src')}/`
      },
      {
        find: /^@nide\/domain\//,
        replacement: `${resolve('packages/domain/src')}/`
      },
      // 精确包名（无子路径）
      { find: '@nide/contracts', replacement: resolve('packages/contracts/src') },
      { find: '@nide/domain', replacement: resolve('packages/domain/src') },
      { find: '@nide/client-kit', replacement: resolve('packages/client-kit/src') },
      { find: '@nide/sdk', replacement: resolve('packages/sdk/src') },
      {
        find: '@nide/client-modules',
        replacement: resolve('packages/client-modules/src/index.ts')
      },
      {
        find: '@nide/client-runtime',
        replacement: resolve('packages/client-runtime/src/index.ts')
      },
      {
        find: '@nide/client-ui-main',
        replacement: resolve('packages/client-ui-main/src/index.ts')
      },
      {
        find: '@nide/client-ui-editor',
        replacement: resolve('packages/client-ui-editor/src/index.ts')
      },
      {
        find: '@nide/client-ui-explorer',
        replacement: resolve('packages/client-ui-explorer/src/index.ts')
      },
      {
        find: '@nide/client-ui-git',
        replacement: resolve('packages/client-ui-git/src/index.ts')
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
        find: '@nide/client-ui-plugins',
        replacement: resolve('packages/client-ui-plugins/src/index.ts')
      },
      {
        find: '@nide/client-ui-renderer',
        replacement: resolve('packages/client-ui-renderer/src/index.tsx')
      },
      {
        find: '@nide/client-ui-slots',
        replacement: resolve('packages/client-ui-slots/src/index.ts')
      }
    ]
  },
  test: {
    // 被测模块是主进程/共享层/渲染进程的纯逻辑，没有 DOM
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 夹具都建在系统临时目录里，不碰仓库的 plugins/
    clearMocks: true
  }
})
