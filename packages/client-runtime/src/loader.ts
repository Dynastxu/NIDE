import { pluginBundleUrl } from '@shared/plugin-api'
import type { ClientBundleDescriptor } from '@shared/plugin-api'

/**
 * 插件浏览器半的运行时加载器。
 *
 * 当前形态（方案 A）：
 * - 插件 bundle 是 IIFE，加载时调用 `window.__NIDE_REGISTER__(viewId, Component)`；
 * - React / ReactDOM 由宿主挂在全局，bundle 里不打包；
 * - 开发期用 Vite dev server 的 `/@fs/<绝对路径>` 取文件；
 * - 打包后用 shell 注册的 `nide-plugin://plugin/<pluginId>/client.js`：渲染进程只给
 *   插件 id，路径由主进程按 host 的清单去查（见 `src/main/protocol/plugin-bundles.ts`）。
 *
 * 两条路都只让渲染进程碰 URL，不碰文件系统 —— 它在 Chromium 沙箱里本来也读不了盘。
 */

const loaded = new Set<string>()

function isDev(): boolean {
  /**
   * 不用 `import.meta.env.DEV`：这个模块被 alias 到源码后，在某些 electron-vite
   * 组合下 `import.meta.env` 可能没有被替换，导致 dev 也被判成生产。
   * 渲染进程的加载方式更直接：dev 是 http://localhost，打包后是 file://。
   */
  return window.location.protocol === 'http:' || window.location.protocol === 'https:'
}

function devBundleUrl(bundlePath: string): string {
  return `/@fs/${bundlePath.replaceAll('\\', '/')}`
}

/** 这个 bundle 该从哪个 URL 取 */
function bundleUrl(descriptor: ClientBundleDescriptor): string {
  return isDev() ? devBundleUrl(descriptor.bundlePath) : pluginBundleUrl(descriptor.pluginId)
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`failed to load client bundle: ${src}`))
    document.head.appendChild(script)
  })
}

/**
 * 加载清单里的全部 bundle。
 *
 * **逐个**吞掉失败：一个插件的 bundle 坏了（文件被删、协议回 404、语法错）不该让
 * 后面的插件一起不加载 —— `PluginSlot` 对没注册的视图还有构建期 glob 兜底，所以
 * 最坏的结果是这一个插件回退到打包进去的那份，而不是整片界面空掉。
 */
export async function loadClientBundles(descriptors: ClientBundleDescriptor[]): Promise<void> {
  for (const descriptor of descriptors) {
    if (descriptor.platform !== 'web') continue

    const url = bundleUrl(descriptor)
    if (loaded.has(url)) continue

    try {
      await injectScript(url)
      loaded.add(url)
      console.info('[nide] client bundle loaded', { pluginId: descriptor.pluginId, url })
    } catch (error) {
      console.warn('[nide] client bundle failed to load', {
        pluginId: descriptor.pluginId,
        url,
        error
      })
    }
  }
}
