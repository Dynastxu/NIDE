/**
 * 插件启用状态的持久化契约。
 *
 * 和 `shared/project` 的分工一致：读取时的收敛规则（坏文件怎么降级、非法项怎么
 * 丢弃）写在这里的**纯函数**里，落盘与 userData 路径解析留在主进程
 * （`src/main/plugin-host/preference.ts`）—— 那些规则可以单独测，不必起 electron。
 *
 * 这一层不 import electron / fs / DOM：`shared` 被三方共用，而渲染进程在 Chromium
 * 沙箱里既没有 fs，也读不到 userData —— 它消费的是 IPC 下发的禁用 id 列表。
 */

/**
 * 落盘的整体形状。
 *
 * 刻意**不含**「所有插件的启用状态」：只有被显式禁用过的插件才会留下记录，
 * 没记录的一律**视为启用**。插件清单由磁盘扫描决定，随时可能多一个（新装的）
 * 或少一个（被移除的），预先物化一份「每个插件一条」的表，反而每处消费点都要
 * 处理「表里没有它」这种要靠约定兜住的情形。
 */
export interface PluginPreference {
  version: number
  /**
   * 被禁用的插件 id。
   *
   * 存**禁用集合**而不是 `{ id: boolean }` 表，理由同上：集合的语义里没有
   * 「默认值是什么」这个问题。界面上的草稿用的也是同一个形状
   * （见 renderer 的 PluginsBrowser），两边不必互相翻译。
   */
  disabled: string[]
}

export const PLUGIN_PREFERENCE_VERSION = 1

/**
 * 落盘文件名（放在 userData 下）。
 *
 * 不叫 `plugins.json`：userData 下已经有一个 `plugins/` 目录（第三方插件的安装
 * 位置，见 plugin-host/index.ts），两者并排时名字必须自己说清谁是谁 —— 一个是
 * 插件本体，一个是用户偏好。
 */
export const PLUGIN_PREFERENCE_FILE_NAME = 'plugin-preferences.json'

export function emptyPluginPreference(): PluginPreference {
  return { version: PLUGIN_PREFERENCE_VERSION, disabled: [] }
}

/**
 * 收敛一个插件 id。
 *
 * 只承认「去掉首尾空白后非空」的字符串：文件是手改得动的，一个 `null` 或空串混进
 * 集合里，会变成一条永远匹配不上任何插件、却一直留在文件里的垃圾。
 */
export function normalizePluginId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

/** 这个插件当前是否启用。没有记录就是启用 */
export function isPluginEnabled(preference: PluginPreference, pluginId: string): boolean {
  const id = normalizePluginId(pluginId)
  if (id.length === 0) return true

  return !preference.disabled.includes(id)
}

/**
 * 把磁盘上的任意 JSON 收敛成一份可用的偏好。
 *
 * 两个刻意的选择，和 parseProjectStore 同源：
 * - **坏数据不抛异常。** 文件损坏或版本不认识时返回空偏好（全部启用），
 *   应用照常启动；为此崩溃换不来任何好处。
 * - **逐项校验而不是整份丢弃。** 一个坏 id 不该带走同一份文件里其他有效的禁用记录。
 *
 * 顺手排序与去重：文件是手改得动的，读的时候收敛一次，后面所有消费者都不必
 * 再各自防一遍（也因此磁盘上的内容总是一个确定的顺序，便于比对）。
 *
 * 刻意**不清理**已经不存在的插件 id：插件清单来自磁盘扫描，这次没扫到不等于用户
 * 卸载了它（目录可能只是暂时不可用）；而重装之后用户的选择应当保留。一条多余 id
 * 的代价只是一次匹配不上的比较。
 */
export function parsePluginPreference(raw: unknown): PluginPreference {
  if (!raw || typeof raw !== 'object') return emptyPluginPreference()

  const source = raw as { version?: unknown; disabled?: unknown }

  // 版本不认识就整体回落：按猜测的语义解释数据，会把插件禁用到用户没打算禁的地方
  if (source.version !== PLUGIN_PREFERENCE_VERSION) return emptyPluginPreference()

  const list = Array.isArray(source.disabled) ? source.disabled : []

  const seen = new Set<string>()
  const disabled: string[] = []
  for (const item of list) {
    const id = normalizePluginId(item)
    if (id.length === 0 || seen.has(id)) continue

    seen.add(id)
    disabled.push(id)
  }

  return { version: PLUGIN_PREFERENCE_VERSION, disabled: disabled.sort() }
}

/**
 * 改一个插件的启用状态。
 *
 * 值没有实际变化时返回**同一个引用**，调用方据此跳过落盘（`removeProject` 有同款
 * 约定）：界面勾选后重新提交一份没变的草稿是常见操作，不该因此写一次磁盘。
 */
export function setPluginEnabled(
  preference: PluginPreference,
  pluginId: string,
  enabled: boolean
): PluginPreference {
  const id = normalizePluginId(pluginId)
  if (id.length === 0) return preference

  if (enabled) {
    if (!preference.disabled.includes(id)) return preference

    return {
      version: PLUGIN_PREFERENCE_VERSION,
      disabled: preference.disabled.filter((item) => item !== id)
    }
  }

  if (preference.disabled.includes(id)) return preference

  return {
    version: PLUGIN_PREFERENCE_VERSION,
    disabled: [...preference.disabled, id].sort()
  }
}
