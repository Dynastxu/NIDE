import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

/**
 * 测试配置。
 *
 * 覆盖范围刻意只包括**不依赖 electron** 的纯逻辑：locale 归一化、语言包合并与
 * 优先级、manifest 的 %key% 解析、加载器对不可信输入的处理，以及仓库里本地化
 * 数据的一致性。真正的集成面（窗口重建、原生菜单、Monaco NLS、IPC）不在这里，
 * 那些得靠手动跑应用验证。
 *
 * 别名必须和 electron.vite.config.ts 保持一致：被测模块内部就用 '@shared/...'
 * 互相引用，少一个别名测试直接解析失败。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer/src')
    }
  },
  test: {
    // 被测模块是主进程/共享层的纯逻辑，没有 DOM
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // 夹具都建在系统临时目录里，不碰仓库的 plugins/
    clearMocks: true
  }
})
