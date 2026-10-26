/**
 * 插件浏览器半的运行时声明。
 *
 * 这一层是主进程 -> 渲染进程的纯数据：只说「哪个插件有一个 bundle、它在哪」。
 * 渲染进程据此拼出一个 URL 去加载：
 *
 * - 开发期：Vite dev server 的 `/@fs/<绝对路径>`（能读到仓库外 / userData 里的文件）；
 * - 打包后：`nide-plugin://<pluginId>/client.js`，由 shell 注册的自定义协议
 *   从磁盘读出同一份文件（见 `src/main/protocol/plugin-bundles.ts`）。
 *
 * 两条路都不让渲染进程碰文件系统 —— 它只认 URL。
 */

/** 插件 bundle 的自定义协议名。开发期不用它，但主进程两侧都按这个名字注册。 */
export const PLUGIN_BUNDLE_SCHEME = 'nide-plugin'

/**
 * 自定义 URL 里的固定 host。
 *
 * 插件 id **不能**放在 host 里：WHATWG 的 URL 解析会把 host 小写化，而插件 id 的大小写
 * 由作者决定（`p.Node` 是合法的）。所以 host 固定成这个字面量，id 放进 path ——
 * path 保留大小写，再配一次 URL 编码就没有歧义。
 */
const BUNDLE_URL_HOST = 'plugin'

/** bundle 在自定义协议里的固定路径名。目前每个插件只有一个入口文件 */
export const PLUGIN_BUNDLE_PATH = 'client.js'

export interface ClientBundleDescriptor {
  pluginId: string
  platform: 'web'
  /**
   * bundle 的**绝对路径**。
   *
   * 开发期由主进程按「插件目录 + manifest.client.bundle」拼出来，渲染进程把它交给
   * Vite dev server 的 `/@fs/`。打包后不用它 —— 那时渲染进程只拿 `pluginId` 拼
   * `nide-plugin://` URL，绝对路径不出主进程。
   */
  bundlePath: string
}

/**
 * 打包后渲染进程加载这个 bundle 的 URL：
 * `nide-plugin://plugin/<encodeURIComponent(pluginId)>/client.js`
 *
 * 只用 `pluginId`，不用路径：路径是用户磁盘上的东西，而且把路径塞进 URL 就得在
 * 主进程里做一次「这个路径允许吗」的校验 —— 换成 id 之后，允许清单就是 host 返回的
 * client bundle 列表本身。
 *
 * 纯函数，渲染进程与测试共用。
 */
export function pluginBundleUrl(pluginId: string): string {
  return `${PLUGIN_BUNDLE_SCHEME}://${BUNDLE_URL_HOST}/${encodeURIComponent(
    pluginId
  )}/${PLUGIN_BUNDLE_PATH}`
}

/**
 * 从协议 URL 里取出插件 id；不是这个协议的 URL 时给 null。
 *
 * 主进程的协议处理器只用它读 id，再用 id 去 host 的清单里找绝对路径 —— 请求里的
 * 路径**不参与**文件定位，所以不存在穿越。
 */
export function pluginIdFromBundleUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  if (parsed.protocol !== `${PLUGIN_BUNDLE_SCHEME}:`) return null
  if (parsed.hostname !== BUNDLE_URL_HOST) return null

  const match = new RegExp(`^/([^/]+)/${PLUGIN_BUNDLE_PATH}$`).exec(parsed.pathname)
  if (!match) return null

  try {
    const pluginId = decodeURIComponent(match[1])
    return pluginId.length > 0 ? pluginId : null
  } catch {
    // 坏掉的百分号编码 —— 不是一个我们可以回答的请求
    return null
  }
}
