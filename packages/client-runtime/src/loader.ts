import type { ClientBundleDescriptor } from '@shared/plugin-api'

/**
 * 插件浏览器半的运行时加载器（MVP）。
 *
 * 当前形态（方案 A）：
 * - 插件 bundle 是 IIFE，加载时调用 `window.__NIDE_REGISTER__(viewId, Component)`；
 * - React / ReactDOM 由宿主挂在全局，bundle 里不打包；
 * - 开发期用 Vite dev server 的 `/@fs/<绝对路径>` 取文件。
 *
 * 生产环境不能走 `/@fs/`：会换成 app 协议（见 docs/architecture/plugin-ui-bundles.md）。
 * 所以这里在非 DEV 下直接跳过并告警，避免留下一个「开发能跑、打包就坏」的路径。
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

export async function loadClientBundles(descriptors: ClientBundleDescriptor[]): Promise<void> {
  if (!isDev()) {
    // TODO: 生产环境用 `nide-plugin://` 或 app 协议提供已构建的 bundle。
    console.warn('[nide] client bundles are only wired for the dev server')
    return
  }

  for (const descriptor of descriptors) {
    if (descriptor.platform !== 'web') continue

    const url = devBundleUrl(descriptor.bundlePath)
    if (loaded.has(url)) continue

    await injectScript(url)
    loaded.add(url)
    console.info('[nide] client bundle loaded', { pluginId: descriptor.pluginId, url })
  }
}
