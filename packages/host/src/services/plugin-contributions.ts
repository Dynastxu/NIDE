import fs from 'node:fs'
import path from 'node:path'
import { normalizeLocale } from '../../../../packages/contracts/src/i18n/locale-tag.ts'
import {
  DEFAULT_NLS_FILE,
  NLS_FILE_RE,
  parsePlaceholder
} from '../../../../packages/contracts/src/plugin-api/manifest-nls.ts'
import { isReservedHostId } from '../../../../packages/contracts/src/plugin-api/view.ts'
import type {
  ViewChromeOptions,
  ViewLocation
} from '../../../../packages/contracts/src/plugin-api/view.ts'
import type {
  PluginLocalePack,
  PluginLocaleTier,
  PluginManifestNls,
  PluginMessages,
  PluginSettingsEntry,
  PluginViewEntry
} from '../../../../packages/contracts/src/plugin-api/contributions.ts'

/**
 * 插件贡献点（视图 / 设置页 / 语言包 / manifest 词条）的读取。
 *
 * 这一段原先在 shell（`src/main/plugin-host/loader.ts`），和 host 的插件清单扫描
 * 各读一遍同样的目录与 manifest。现在读盘只有这一处：host 把结果作为**纯数据**
 * 下发，shell 只消费（标题解析仍在 shell —— 那要用当前语言）。
 *
 * 三个刻意的边界，与搬迁前逐条一致：
 *
 * 1. **路径不可信**：语言包文件、设置页入口都是 manifest 里写的字符串，绝对路径与
 *    `../` 一律挡掉，否则一个插件就能读到磁盘任意位置。
 * 2. **坏一项不带走整份**：一条坏声明只跳过它自己，其余照常；只有 id 占用宿主保留
 *    空间才整份拒绝（那会让插件的视图顶掉内建视图）。
 * 3. **原样存标题**：存 `titleSpec` 而不是解析结果，解析要等 shell 知道当前语言。
 */

/** 视图入口的默认约定：插件目录下的 src/ui/index.tsx */
export const DEFAULT_VIEW_ENTRY = 'src/ui/index.tsx'

/** 设置页入口的默认约定：插件目录下的 src/settings/index.tsx */
export const DEFAULT_SETTINGS_ENTRY = 'src/settings/index.tsx'

/** 合法的挂载位置（与渲染进程的 6 个工具区 + 主编辑区一一对应） */
const VALID_LOCATIONS: ReadonlySet<string> = new Set([
  'leftTop',
  'leftBottom',
  'rightTop',
  'rightBottom',
  'bottomLeft',
  'bottomRight',
  'main'
])

/** 旧契约 -> 新契约：老插件不用改 manifest 也能落在合理的位置 */
const LEGACY_LOCATIONS: Record<string, ViewLocation> = {
  sidebar: 'rightTop',
  panel: 'bottomLeft'
}

const FALLBACK_LOCATION: ViewLocation = 'rightTop'

/**
 * manifest 里 `contributes.views[].chrome` 认得的字段。
 *
 * 单独列出来而不是直接遍历对象：多出来的键会被静默忽略，作者拼错 `ttile` 时
 * 不会有任何提示 —— 而这张表让「哪些键有用」有一个可读的答案。
 */
const CHROME_FLAGS = ['header', 'title', 'more', 'minimize', 'tabs'] as const

/**
 * 本模块的日志出口。
 *
 * 可替换（`setContributionsLogger`）是为了测试：这些用例刻意制造坏输入，既要静音
 * 输出，又要能断言「有没有报警」。生产代码永远用默认值。
 */
export interface ContributionsLogger {
  error: (message: string, fields?: Record<string, unknown>) => void
  warn: (message: string, fields?: Record<string, unknown>) => void
  debug: (message: string, fields?: Record<string, unknown>) => void
}

function consoleLogger(): ContributionsLogger {
  const emit =
    (level: 'error' | 'warn' | 'debug') => (message: string, fields?: Record<string, unknown>) => {
      if (fields) console[level](`[nide-host] ${message}`, fields)
      else console[level](`[nide-host] ${message}`)
    }

  return { error: emit('error'), warn: emit('warn'), debug: emit('debug') }
}

let logger: ContributionsLogger = consoleLogger()

export function setContributionsLogger(next: ContributionsLogger): void {
  logger = next
}

/**
 * 把 manifest 里写的 location 归一化成合法的 ViewLocation。
 *
 * 渲染进程按 location 把视图塞进对应的工具区，一个不认识的值会让视图在任何区里都
 * 匹配不上 —— 表现为「插件加载了但界面上什么都看不到」，所以这里宁可回落到默认值
 * 并告警，也不把脏值透传给渲染进程。
 */
function normalizeLocation(raw: string | undefined, viewId: string): ViewLocation {
  const key = raw ?? FALLBACK_LOCATION

  if (VALID_LOCATIONS.has(key)) return key as ViewLocation

  const legacy = LEGACY_LOCATIONS[key]
  if (legacy) {
    logger.warn('View uses a legacy location, mapping it', { viewId, from: key, to: legacy })
    return legacy
  }

  logger.warn('View has an invalid location, falling back', {
    viewId,
    location: key,
    fallback: FALLBACK_LOCATION
  })
  return FALLBACK_LOCATION
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/**
 * 收敛 manifest 里写的 chrome 开关。
 *
 * 只接受布尔值，其余一律丢弃并告警：这份数据会跨 IPC 送到渲染进程并直接决定界面画
 * 什么，而 manifest 是插件作者手写的 JSON —— 一个 `"false"` 字符串在这里被当成真值，
 * 界面上就会多出一个作者明确想关掉的按钮。
 *
 * 逐字段校验而不是整份丢弃：写坏一项不该带走同一份声明里其他有效的开关。
 * 全部省略时返回 undefined，让渲染进程直接落到默认值（全开）。
 */
function normalizeViewChrome(
  raw: unknown,
  pluginId: string,
  viewId: string
): ViewChromeOptions | undefined {
  if (raw === undefined) return undefined

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn('View chrome must be an object, the declaration is ignored', {
      pluginId,
      viewId,
      valueType: typeof raw
    })
    return undefined
  }

  const source = raw as Record<string, unknown>
  const chrome: ViewChromeOptions = {}

  for (const key of CHROME_FLAGS) {
    const value = source[key]
    if (value === undefined) continue

    if (typeof value !== 'boolean') {
      logger.warn('View chrome flag must be a boolean, the flag is ignored', {
        pluginId,
        viewId,
        flag: key,
        valueType: typeof value
      })
      continue
    }

    chrome[key] = value
  }

  return chrome
}

/**
 * 把 manifest 里的相对路径解析成绝对路径，并保证它没跑出插件目录。
 *
 * 语言包文件与设置页入口都是 manifest **外部内容**，路径完全由插件作者填写，所以必须
 * 当成不可信输入：绝对路径和 `../` 都要挡掉，否则一个插件就能读到磁盘任意位置。
 */
function resolveInsidePlugin(pluginDir: string, relativePath: string, what: string): string | null {
  const absolute = path.resolve(pluginDir, relativePath)
  const relative = path.relative(pluginDir, absolute)

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    logger.warn('Path escaped the plugin directory, ignored', { what, relativePath })
    return null
  }

  return absolute
}

/**
 * 读一个词条文件（语言包，或插件的 manifest 词条）。
 *
 * 只接受「扁平 key -> 字符串」的 JSON 对象。非字符串的值单独告警并跳过，而不是整份
 * 作废 —— 作者手滑写了个数字不该让整个语言不可用。
 */
function readMessageTable(absolutePath: string): PluginMessages | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf-8'))
  } catch (err) {
    logger.error('Failed to read the entry file', { file: absolutePath, error: err })
    return null
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logger.error('Entry file must be a JSON object', { file: absolutePath })
    return null
  }

  const table: PluginMessages = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      logger.warn('Entry file has a non-string message, skipped', {
        file: absolutePath,
        key,
        valueType: typeof value
      })
      continue
    }
    table[key] = value
  }

  return table
}

/**
 * 读插件目录下的 manifest 词条文件：`package.nls.json` 与 `package.nls.<locale>.json`。
 *
 * 文件名是**约定**而不是 manifest 声明的，所以没有路径穿越的余地 —— 但也只扫插件
 * 目录的直接子项，不递归。
 *
 * 一个词条文件都没有时返回 null，表示这个插件没做 manifest 本地化（完全合法）。
 */
export function readManifestNls(pluginDir: string): PluginManifestNls | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(pluginDir)
  } catch (err) {
    logger.error('Failed to read the plugin directory for manifest messages', {
      dir: pluginDir,
      error: err
    })
    return null
  }

  const byLocale: Record<string, PluginMessages> = {}
  let defaultTable: PluginMessages | undefined

  for (const name of entries) {
    const match = NLS_FILE_RE.exec(name)
    const isDefault = name === DEFAULT_NLS_FILE
    if (!isDefault && !match) continue

    const table = readMessageTable(path.join(pluginDir, name))
    if (!table) continue

    // 文件名里的大小写由作者决定（zh-cn / en-US 都合法），统一规范化成 key
    const locale = match?.[1]
    if (locale) byLocale[normalizeLocale(locale)] = table
    else defaultTable = table
  }

  if (!defaultTable && Object.keys(byLocale).length === 0) return null
  return { ...(defaultTable ? { defaultTable } : {}), byLocale }
}

/**
 * 占位符在**任何**词条文件里都找不到时，界面上会原样显示 `%key%`。
 * 这明显是漏配，启动时就说出来，别等用户看见乱码。
 *
 * 这里只查「完全找不到」这种硬错误。「某个语言缺了这一条」属于不完整，
 * 交给构建期的 check-locales 脚本穷举，运行时不必刷屏。
 */
function warnUnresolvableTitle(
  pluginId: string,
  targetId: string,
  titleSpec: string,
  tables: PluginManifestNls | null,
  what: 'View' | 'Settings page'
): void {
  const key = parsePlaceholder(titleSpec)
  if (key === null) return

  if (!tables) {
    logger.error(
      `${what} title uses the placeholder "${titleSpec}" but the plugin ships no message file, ` +
        'the raw placeholder will be displayed',
      { pluginId, targetId, key, file: DEFAULT_NLS_FILE }
    )
    return
  }

  const inDefault = tables.defaultTable?.[key] !== undefined
  const inAnyLocale = Object.values(tables.byLocale).some((table) => table[key] !== undefined)

  if (!inDefault && !inAnyLocale) {
    logger.error(
      `${what} title uses the placeholder "${titleSpec}" that no message file defines, ` +
        'the raw placeholder will be displayed',
      { pluginId, targetId, key }
    )
  }
}

/** raw manifest 里这一层是手写 JSON，形状完全不可信 */
interface RawContributes {
  views?: unknown
  settings?: unknown
  locales?: unknown
}

export interface ReadContributionsOptions {
  pluginDir: string
  pluginId: string
  /** 从哪个目录扫出来的，决定语言包在瀑布链里的优先级 */
  source: PluginLocaleTier
  /** manifest 的 contributes 对象（原样） */
  contributes?: unknown
}

/**
 * 一个插件的贡献点。与下发的 `PluginContributions` 只差 manifests 的聚合方式：
 * 这里是「这个插件自己的词条表」，那边是 `pluginId -> 词条表` 的汇总。
 */
export interface PluginContributionSet {
  views: PluginViewEntry[]
  settings: PluginSettingsEntry[]
  locales: PluginLocalePack[]
  manifestNls?: PluginManifestNls
}

/**
 * 读一个插件的全部贡献点。插件 id 占用宿主保留空间时返回 null（整份拒绝）。
 *
 * 只读盘、不注册：调用方（`PluginManager`）负责把结果挂到清单上，再由 RPC 下发。
 */
export function readPluginContributions(
  options: ReadContributionsOptions
): PluginContributionSet | null {
  const { pluginDir, pluginId, source } = options
  const dir = path.basename(pluginDir)

  /**
   * 保留 id 空间在**任何读取发生之前**拒绝。
   *
   * 越界的后果不是报错而是串台：这个插件的视图会被当成内建视图送进 HostSlot，
   * 在设置里禁用 `host` 还会把内建视图一起关掉。这里连同它的语言包一起拒绝 ——
   * 一个连身份都不合法的插件，不该有机会往词条表里写东西。
   */
  if (isReservedHostId(pluginId)) {
    logger.error('Plugin id claims the host namespace, the plugin is rejected', {
      pluginId,
      dir
    })
    return null
  }

  const contributes: RawContributes =
    options.contributes && typeof options.contributes === 'object'
      ? (options.contributes as RawContributes)
      : {}

  const views: PluginViewEntry[] = []
  const settings: PluginSettingsEntry[] = []
  const locales: PluginLocalePack[] = []

  // manifest 文案的词条先读进来：下面注册视图时要拿它校验占位符能不能落地
  const manifestNls = readManifestNls(pluginDir)

  const viewContributions = Array.isArray(contributes.views) ? contributes.views : []
  for (const raw of viewContributions) {
    if (!raw || typeof raw !== 'object') continue
    const view = raw as {
      id?: unknown
      title?: unknown
      location?: unknown
      icon?: unknown
      chrome?: unknown
      entry?: unknown
    }

    // 视图 id 同样不得占用保留空间：内建视图与插件视图共用同一张表
    if (typeof view.id !== 'string' || view.id.length === 0 || isReservedHostId(view.id)) {
      logger.error('View id claims the host namespace, the view is skipped', {
        pluginId,
        viewId: view.id,
        dir
      })
      continue
    }

    const entryAbs = path.resolve(
      pluginDir,
      typeof view.entry === 'string' && view.entry.length > 0 ? view.entry : DEFAULT_VIEW_ENTRY
    )
    // 关键：只传「插件目录内的相对路径」——不含盘符、不依赖 cwd，
    // dev 与打包后的取值完全一致。
    const entry = toPosix(path.relative(pluginDir, entryAbs))

    const titleSpec = typeof view.title === 'string' && view.title.length > 0 ? view.title : view.id
    warnUnresolvableTitle(pluginId, view.id, titleSpec, manifestNls, 'View')

    const chrome = normalizeViewChrome(view.chrome, pluginId, view.id)

    views.push({
      id: view.id,
      pluginId,
      titleSpec,
      location: normalizeLocation(
        typeof view.location === 'string' ? view.location : undefined,
        view.id
      ),
      ...(typeof view.icon === 'string' && view.icon.length > 0 ? { icon: view.icon } : {}),
      ...(chrome ? { chrome } : {}),
      dir,
      entry
    })

    logger.debug('View contribution read', { viewId: view.id, dir, entry })
  }

  /**
   * manifest 是插件作者手写的 JSON，`settings` 不保证是数组、条目也不保证是对象。
   * 这里逐项收敛，坏条目跳过而不是让整个插件加载失败。
   */
  const settingsContributions = Array.isArray(contributes.settings) ? contributes.settings : []

  for (const raw of settingsContributions) {
    if (!raw || typeof raw !== 'object') continue
    const setting = raw as {
      id?: unknown
      title?: unknown
      entry?: unknown
      order?: unknown
    }

    /**
     * 设置页 id 同样不能占用宿主命名空间。它和视图 id 不在一张表里，但 `host.*` 是
     * 宿主保留前缀这条规则是全局的 —— 以后宿主自己的设置页要用这个命名空间时，
     * 不该被插件提前占掉。
     */
    if (typeof setting.id !== 'string' || setting.id.length === 0 || isReservedHostId(setting.id)) {
      logger.error('Settings page id claims the host namespace, the page is skipped', {
        pluginId,
        settingsId: setting.id,
        dir
      })
      continue
    }

    const declaredEntry =
      typeof setting.entry === 'string' && setting.entry.length > 0
        ? setting.entry
        : DEFAULT_SETTINGS_ENTRY

    /**
     * 入口路径必须落在插件目录内。视图入口目前只做 `path.resolve` + 相对化，
     * 设置页这边多一道 `resolveInsidePlugin`：入口会直接进构建期的 glob 表，
     * 一个 `../../` 就能让插件声明到别的插件目录里去。
     */
    const absolute = resolveInsidePlugin(
      pluginDir,
      declaredEntry,
      `settings page ${pluginId}/${setting.id}`
    )
    if (!absolute) continue

    if (!fs.existsSync(absolute)) {
      logger.error('Settings page entry not found', {
        pluginId,
        settingsId: setting.id,
        file: absolute,
        declared: declaredEntry
      })
      continue
    }

    const titleSpec =
      typeof setting.title === 'string' && setting.title.length > 0 ? setting.title : setting.id
    warnUnresolvableTitle(pluginId, setting.id, titleSpec, manifestNls, 'Settings page')

    settings.push({
      id: setting.id,
      pluginId,
      titleSpec,
      dir,
      entry: toPosix(path.relative(pluginDir, absolute)),
      order: typeof setting.order === 'number' && Number.isFinite(setting.order) ? setting.order : 0
    })

    logger.debug('Settings page contribution read', { settingsId: setting.id, dir })
  }

  const localeContributions = Array.isArray(contributes.locales) ? contributes.locales : []

  for (const raw of localeContributions) {
    if (!raw || typeof raw !== 'object') continue
    const contribution = raw as { locale?: unknown; label?: unknown; file?: unknown }

    if (
      typeof contribution.locale !== 'string' ||
      contribution.locale.length === 0 ||
      typeof contribution.file !== 'string' ||
      contribution.file.length === 0
    ) {
      logger.warn('Locale contribution is missing locale or file', { pluginId })
      continue
    }

    const absolute = resolveInsidePlugin(
      pluginDir,
      contribution.file,
      `language pack ${pluginId}/${contribution.locale}`
    )
    if (!absolute) continue

    if (!fs.existsSync(absolute)) {
      logger.error('Language pack file not found', {
        file: absolute,
        pluginId,
        declared: contribution.file
      })
      continue
    }

    const messages = readMessageTable(absolute)
    if (!messages) continue

    locales.push({
      locale: normalizeLocale(contribution.locale),
      // label 是语言的「自称」，缺失时退回 locale 本身，至少还能选
      label:
        typeof contribution.label === 'string' && contribution.label.length > 0
          ? contribution.label
          : contribution.locale,
      source,
      pluginId,
      dir,
      messages
    })

    logger.debug('Language pack contribution read', {
      locale: contribution.locale,
      pluginId,
      source,
      messages: Object.keys(messages).length
    })
  }

  return { views, settings, locales, ...(manifestNls ? { manifestNls } : {}) }
}
