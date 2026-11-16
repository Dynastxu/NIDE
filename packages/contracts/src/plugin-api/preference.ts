/**
 * 插件启用状态的持久化契约。
 *
 * 和 `shared/project` 的分工一致：读取时的收敛规则（坏文件怎么降级、非法项怎么
 * 丢弃）写在这里的**纯函数**里，落盘与 userData 路径解析在 host
 * （`packages/services/plugins/src/plugins.ts`）—— 那些规则可以单独测，不必起 electron。
 *
 * 这一层不 import electron / fs / DOM：`shared` 被三方共用，而渲染进程在 Chromium
 * 沙箱里既没有 fs，也读不到 userData —— 它消费的是 IPC 下发的禁用 id 列表。
 */

/**
 * 落盘的整体形状。
 *
 * 两份集合，语义互补：
 * - `disabled`：用户显式关掉的插件；
 * - `enabled`：用户显式打开过的插件（主要是清单里声明了 `defaultDisabled` 的）。
 *
 * 没出现在任何一份里的插件按清单默认值走（默认启用；`defaultDisabled` 默认禁用）。
 * 不物化「每个插件一条」的表：插件清单来自磁盘扫描，随时可能多一个或少一个。
 */
export interface PluginPreference {
  version: number
  disabled: string[]
  /** 显式启用集合；老文件没有这个字段时按空处理 */
  enabled: string[]
}

/** 清单里影响「默认是否启用」的标记 */
export interface PluginEnabledFlags {
  /** 内核级插件：界面不可禁用 */
  core?: boolean
  /** 必需插件：界面不可禁用（例如插件管理页本身） */
  essential?: boolean
  /** 首次出现时默认禁用，用户启用后写进 `enabled` */
  defaultDisabled?: boolean
}

export const PLUGIN_PREFERENCE_VERSION = 1

/**
 * 落盘文件名（放在 userData 下）。
 *
 * 不叫 `plugins.json`：userData 下已经有一个 `plugins/` 目录（第三方插件的安装
 * 位置），两者并排时名字必须自己说清谁是谁 —— 一个是插件本体，一个是用户偏好。
 */
export const PLUGIN_PREFERENCE_FILE_NAME = 'plugin-preferences.json'

export function emptyPluginPreference(): PluginPreference {
  return { version: PLUGIN_PREFERENCE_VERSION, disabled: [], enabled: [] }
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

/**
 * 这个插件当前是否启用。
 *
 * 顺序：core / essential 永远启用 → 显式启用 → 显式禁用 → 清单默认值。
 * 显式启用优先于显式禁用，保证用户最后一次操作有效（两份集合理论上不会同时
 * 命中，但文件是手改得动的）。
 */
export function isPluginEnabled(
  preference: PluginPreference,
  pluginId: string,
  flags: PluginEnabledFlags = {}
): boolean {
  const id = normalizePluginId(pluginId)
  if (id.length === 0) return true
  if (flags.core === true || flags.essential === true) return true
  if (preference.enabled.includes(id)) return true
  if (preference.disabled.includes(id)) return false
  return flags.defaultDisabled !== true
}

function normalizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []

  const seen = new Set<string>()
  const list: string[] = []
  for (const item of raw) {
    const id = normalizePluginId(item)
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    list.push(id)
  }
  return list.sort()
}

/**
 * 把磁盘上的任意 JSON 收敛成一份可用的偏好。
 *
 * 两个刻意的选择，和 parseProjectStore 同源：
 * - **坏数据不抛异常。** 文件损坏或版本不认识时返回空偏好（全部启用），
 *   应用照常启动；为此崩溃换不来任何好处。
 * - **逐项校验而不是整份丢弃。** 一个坏 id 不该带走同一份文件里其他有效的记录。
 */
export function parsePluginPreference(raw: unknown): PluginPreference {
  if (!raw || typeof raw !== 'object') return emptyPluginPreference()

  const source = raw as { version?: unknown; disabled?: unknown; enabled?: unknown }

  // 版本不认识就整体回落：按猜测的语义解释数据，会把插件禁用到用户没打算禁的地方
  if (source.version !== PLUGIN_PREFERENCE_VERSION) return emptyPluginPreference()

  return {
    version: PLUGIN_PREFERENCE_VERSION,
    disabled: normalizeList(source.disabled),
    enabled: normalizeList(source.enabled)
  }
}

/**
 * 改一个插件的启用状态。
 *
 * 值没有实际变化时返回**同一个引用**，调用方据此跳过落盘：界面勾选后重新提交
 * 一份没变的草稿是常见操作，不该因此写一次磁盘。
 *
 * `core` / `essential` 插件拒绝改动（返回同一个引用）—— 禁掉内核等于关掉应用，
 * 界面那边应该直接置灰，而不是让用户点了之后再回滚。
 */
export function setPluginEnabled(
  preference: PluginPreference,
  pluginId: string,
  enabled: boolean,
  flags: PluginEnabledFlags = {}
): PluginPreference {
  const id = normalizePluginId(pluginId)
  if (id.length === 0) return preference
  if (flags.core === true || flags.essential === true) return preference

  if (enabled) {
    const alreadyEnabled = preference.enabled.includes(id)
    const wasDisabled = preference.disabled.includes(id)
    // 默认启用的插件不需要在 enabled 里留记录；默认禁用的需要
    const needsRecord = flags.defaultDisabled === true
    if (!wasDisabled && (!needsRecord || alreadyEnabled)) return preference

    return {
      version: PLUGIN_PREFERENCE_VERSION,
      disabled: preference.disabled.filter((item) => item !== id),
      enabled: needsRecord
        ? [...new Set([...preference.enabled, id])].sort()
        : preference.enabled.filter((item) => item !== id)
    }
  }

  if (preference.disabled.includes(id)) return preference

  return {
    version: PLUGIN_PREFERENCE_VERSION,
    disabled: [...preference.disabled, id].sort(),
    enabled: preference.enabled.filter((item) => item !== id)
  }
}
