/**
 * 插件浏览器半的运行时声明。
 *
 * 这一层是主进程 -> 渲染进程的纯数据：只说「哪个插件有一个 bundle、它在哪」。
 * 渲染进程在开发期把绝对路径转成 Vite `/@fs/` URL；生产环境会换成 app 协议
 * （见 docs/architecture/plugin-ui-bundles.md 的 TODO）。
 */
export interface ClientBundleDescriptor {
  pluginId: string
  platform: 'web'
  /**
   * bundle 的绝对路径。
   *
   * 开发期由主进程按「插件目录 + manifest.client.bundle」拼出来。
   * 渲染进程**不**直接读盘，只把它交给 Vite dev server 的 `/@fs/`。
   */
  bundlePath: string
}
