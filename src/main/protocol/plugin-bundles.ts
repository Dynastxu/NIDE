import fs from 'node:fs/promises'
import { protocol } from 'electron'
import { PLUGIN_BUNDLE_SCHEME, pluginIdFromBundleUrl } from '@shared/plugin-api'
import { invokeHost } from '../host/process'
import { loggerFor } from '../logger'
import type { ClientBundleDescriptor } from '@shared/plugin-api'

/**
 * 插件浏览器半的 bundle 协议（`nide-plugin://`）。
 *
 * 打包后没有 Vite dev server，渲染进程也就没有 `/@fs/` 可以取文件。这里给 shell 注册
 * 一个小协议：`nide-plugin://plugin/<pluginId>/client.js` 读出的正是 host 清单里那个
 * 插件的 bundle 文件。
 *
 * 三条刻意的约束：
 *
 * 1. **URL 里的路径不参与定位**。处理器只用 URL 里的 pluginId 去 host 的
 *    `plugins.clientBundles` 里查绝对路径 —— 允许清单就是 host 的那份清单，
 *    不存在「渲染进程拼一个路径读到别处」的可能。
 * 2. **每次请求都问 host**。清单会随安装 / 卸载 / 启停变化，缓存一份就要处理失效，
 *    而这里一次窗口加载只会来几次请求。host 不在时回 503，渲染进程那边按加载失败
 *    处理（回退到构建期 glob，界面不至于空着）。
 * 3. **Content-Type 明确给 `text/javascript`**：Chromium 对脚本做 MIME 检查，
 *    从文件读出来的字节没有类型，猜错就是整个插件不执行。
 */

const logger = loggerFor('plugin-bundles')

/**
 * 登记这个 scheme 的权限位。
 *
 * **必须在 `app.whenReady()` 之前调用**，而且只能调一次 —— Electron 只允许在 ready
 * 之前登记 scheme 的 privileges。
 */
export function registerPluginBundleScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_BUNDLE_SCHEME,
      privileges: {
        // standard：按 URL 规则解析（有 host / path），页面里才有稳定的 origin
        standard: true,
        // secure：当作安全上下文，和 file:// 页面里的其它资源一致
        secure: true,
        supportFetchAPI: true
      }
    }
  ])
}

/** 挂上处理器。必须在 `app.whenReady()` 之后调用。 */
export function registerPluginBundleProtocol(): void {
  protocol.handle(PLUGIN_BUNDLE_SCHEME, async (request) => {
    if (request.method !== 'GET') return new Response(null, { status: 405 })

    const pluginId = pluginIdFromBundleUrl(request.url)
    if (pluginId === null) {
      logger.warn('Rejected a malformed plugin bundle request', { url: request.url })
      return new Response(null, { status: 400 })
    }

    let bundles: ClientBundleDescriptor[]
    try {
      // 3s 够了：这是本地进程间的一次内存查询，超时说明 host 真的不在
      bundles = await invokeHost<ClientBundleDescriptor[]>('plugins', 'clientBundles', [], 3_000)
    } catch (error) {
      logger.error('Failed to read the client bundle list through host', { pluginId, error })
      return new Response(null, { status: 503 })
    }

    const bundle = bundles.find((entry) => entry.pluginId === pluginId)
    if (!bundle) {
      // 插件未启用、已卸载，或者 manifest 根本没声明浏览器半
      logger.warn('Plugin bundle requested but not in the host catalog', { pluginId })
      return new Response(null, { status: 404 })
    }

    try {
      const source = await fs.readFile(bundle.bundlePath, 'utf-8')
      return new Response(source, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          // 重装插件后同名 URL 必须取到新文件：缓存交给渲染进程的 loaded 集合去去重
          'cache-control': 'no-store'
        }
      })
    } catch (error) {
      logger.error('Failed to read a plugin bundle', {
        pluginId,
        bundlePath: bundle.bundlePath,
        error
      })
      return new Response(null, { status: 404 })
    }
  })
}
