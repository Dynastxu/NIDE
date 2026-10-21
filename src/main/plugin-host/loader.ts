import fs from 'node:fs'
import path from 'node:path'
import { normalizeLocale } from '@shared/i18n'
import { permissionManager } from './permission'
import { uiRegistry } from './ui-registry'
import { settingsRegistry } from './settings-registry'
import { languagePackRegistry } from '../i18n'
import {
  DEFAULT_NLS_FILE,
  NLS_FILE_RE,
  manifestNlsRegistry,
  parsePlaceholder
} from '../i18n/manifest-nls'
import { loggerFor } from '../logger'
import type { LocaleId, LocaleSourceTier, MessageTable } from '@shared/i18n'
import type { ManifestNlsTables } from '../i18n/manifest-nls'
import { isReservedHostId } from '@shared/plugin-api'
import type { PluginManifest, ViewChromeOptions, ViewLocation } from '@shared/plugin-api'
import type { Logger } from '@shared/logger'

/**
 * 本模块的日志出口。
 *
 * 可替换（`setPluginHostLogger`）是**为了测试**：这个加载器是纯逻辑模块，
 * 单元测试不该为了断言一条告警就去 import electron-log（那会把整个主进程的
 * Electron 依赖拖进测试环境）。生产代码永远用默认值，注入只发生在测试里。
 */
let logger: Logger = loggerFor('plugin-host')

export function setPluginHostLogger(next: Logger): void {
  logger = next
}

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
 * 把 manifest 里写的 location 归一化成合法的 ViewLocation。
 *
 * 渲染进程按 location 把视图塞进对应的工具区，一个不认识的值会让视图
 * 在任何区里都匹配不上 —— 表现为「插件加载了但界面上什么都看不到」，
 * 所以这里宁可回落到默认值并告警，也不把脏值透传给渲染进程。
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
 * 只接受布尔值，其余一律丢弃并告警：这份数据会跨 IPC 送到渲染进程并直接决定
 * 界面画什么，而 manifest 是插件作者手写的 JSON —— 一个 `"false"` 字符串在这里
 * 被当成真值，界面上就会多出一个作者明确想关掉的按钮。
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
 * 语言包文件是 manifest **外部内容**，路径完全由插件作者填写，所以必须当成
 * 不可信输入：绝对路径和 `../` 都要挡掉，否则一个插件就能读到磁盘任意位置。
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
 * 只接受「扁平 key -> 字符串」的 JSON 对象。非字符串的值单独告警并跳过，
 * 而不是整份作废 —— 作者手滑写了个数字不该让整个语言不可用。
 */
function readMessageTable(absolutePath: string): MessageTable | null {
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

  const table: MessageTable = {}
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
 * 文件名是**约定**而不是 manifest 声明的，所以没有路径穿越的余地 ——
 * 但也只扫插件目录的直接子项，不递归。
 *
 * 一个词条文件都没有时返回 null，表示这个插件没做 manifest 本地化（完全合法）。
 */
function readManifestNls(pluginDir: string): ManifestNlsTables | null {
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

  const byLocale: Record<LocaleId, MessageTable> = {}
  let defaultTable: MessageTable | undefined

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
  tables: ManifestNlsTables | null,
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

export class PluginLoader {
  /**
   * 读取 manifest.json，注册权限、UI 视图贡献点、设置页与语言包。
   *
   * 只做「发现 + 注册」，不启动插件后端子进程。
   * 后端沙箱留给后续阶段，且必须改成
   * 「子进程发 { id, method, params } -> 主进程 dispatch 执行 -> 回包」的形式，
   * 绝不能把带函数的 context 直接 postMessage 过去。
   *
   * 语言包之所以能这么轻，正是因为上面这条约束：它不需要跑任何代码，
   * 宿主只要读一个 JSON 就完事，完全落在「主进程读盘 -> 纯数据下发」的既有链路上。
   *
   * @param manifestPath manifest.json 文件路径
   * @param source 这个插件是从哪个目录扫出来的，决定它和同名语言包冲突时的优先级
   */
  loadContributions(
    manifestPath: string,
    source: LocaleSourceTier = 'builtin'
  ): PluginManifest | null {
    let manifest: PluginManifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as PluginManifest
    } catch (err) {
      logger.error('Failed to parse the manifest file', { file: manifestPath, error: err })
      return null
    }

    const pluginDir = path.dirname(manifestPath)
    const dir = path.basename(pluginDir)

    /**
     * 保留 id 空间在**任何注册发生之前**拒绝，整个 manifest 都不作数。
     *
     * 越界的后果不是报错而是串台：这个插件的视图会被当成内建视图送进 HostSlot，
     * 在设置里禁用 `host` 还会把内建视图一起关掉。而 UIRegistry 与插件清单都是
     * 同名覆盖，放过它就等于让插件悄悄顶掉宿主自己的登记项。
     *
     * 这里连同它的语言包一起拒绝：一个连身份都不合法的插件，不该有机会往
     * 词条表里写东西 —— 词条表是全局共享的，污染面比视图表更大。
     */
    if (isReservedHostId(manifest.id)) {
      logger.error('Plugin id claims the host namespace, the plugin is rejected', {
        file: manifestPath,
        pluginId: manifest.id,
        dir
      })
      return null
    }

    permissionManager.register(manifest.id, manifest.permissions ?? [])

    // manifest 文案的词条先读进来：下面注册视图时要拿它校验占位符能不能落地
    const nlsTables = readManifestNls(pluginDir)
    if (nlsTables) manifestNlsRegistry.register(manifest.id, nlsTables)

    for (const view of manifest.contributes?.views ?? []) {
      // 视图 id 同样不得占用保留空间：内建视图与插件视图共用同一张表，
      // 同名注册是覆盖而不是报错，必须在这里拦下（见 isReservedHostId）
      if (isReservedHostId(view.id)) {
        logger.error('View id claims the host namespace, the view is skipped', {
          pluginId: manifest.id,
          viewId: view.id,
          dir
        })
        continue
      }

      const entryAbs = path.resolve(pluginDir, view.entry ?? DEFAULT_VIEW_ENTRY)
      // 关键：只传「插件目录内的相对路径」——不含盘符、不依赖 cwd，
      // dev 与打包后的取值完全一致。
      const entry = toPosix(path.relative(pluginDir, entryAbs))

      const titleSpec = view.title ?? view.id
      warnUnresolvableTitle(manifest.id, view.id, titleSpec, nlsTables, 'View')

      const chrome = normalizeViewChrome(view.chrome, manifest.id, view.id)

      uiRegistry.register({
        id: view.id,
        // 存原始值而不是解析结果：解析要用当前语言，而这里跑在 initI18n() 之前。
        // 真正解析发生在 host:get-plugin-views 被调用时，见 manifest-nls.ts
        titleSpec,
        location: normalizeLocation(view.location, view.id),
        icon: view.icon,
        // 与标题同理存原样：它是纯数据，渲染进程合并默认值时才知道缺了哪几项
        ...(chrome ? { chrome } : {}),
        pluginId: manifest.id,
        dir,
        entry
      })

      logger.debug('View registered', { viewId: view.id, dir, entry })
    }

    /**
     * manifest 是插件作者手写的 JSON，`settings` 不保证是数组、条目也不保证是对象。
     * 这里逐项收敛，坏条目跳过而不是让整个插件加载失败。
     */
    const settingsContributions = Array.isArray(manifest.contributes?.settings)
      ? manifest.contributes.settings
      : []

    for (const setting of settingsContributions) {
      if (!setting || typeof setting !== 'object') continue

      /**
       * 设置页 id 同样不能占用宿主命名空间。它和视图 id 不在一张表里，但
       * `host.*` 是宿主保留前缀这条规则是全局的 —— 以后宿主自己的设置页要
       * 用这个命名空间时，不该被插件提前占掉。
       */
      if (
        typeof setting.id !== 'string' ||
        setting.id.length === 0 ||
        isReservedHostId(setting.id)
      ) {
        logger.error('Settings page id claims the host namespace, the page is skipped', {
          pluginId: manifest.id,
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
        `settings page ${manifest.id}/${setting.id}`
      )
      if (!absolute) continue

      if (!fs.existsSync(absolute)) {
        logger.error('Settings page entry not found', {
          pluginId: manifest.id,
          settingsId: setting.id,
          file: absolute,
          declared: declaredEntry
        })
        continue
      }

      const titleSpec =
        typeof setting.title === 'string' && setting.title.length > 0 ? setting.title : setting.id
      warnUnresolvableTitle(manifest.id, setting.id, titleSpec, nlsTables, 'Settings page')

      settingsRegistry.register({
        id: setting.id,
        pluginId: manifest.id,
        titleSpec,
        dir,
        entry: toPosix(path.relative(pluginDir, absolute)),
        order:
          typeof setting.order === 'number' && Number.isFinite(setting.order) ? setting.order : 0
      })

      logger.debug('Settings page registered', { settingsId: setting.id, dir })
    }

    for (const contribution of manifest.contributes?.locales ?? []) {
      if (!contribution.locale || !contribution.file) {
        logger.warn('Locale contribution is missing locale or file', { pluginId: manifest.id })
        continue
      }

      const absolute = resolveInsidePlugin(
        pluginDir,
        contribution.file,
        `language pack ${manifest.id}/${contribution.locale}`
      )
      if (!absolute) continue

      if (!fs.existsSync(absolute)) {
        logger.error('Language pack file not found', {
          file: absolute,
          pluginId: manifest.id,
          declared: contribution.file
        })
        continue
      }

      const messages = readMessageTable(absolute)
      if (!messages) continue

      languagePackRegistry.register({
        locale: contribution.locale,
        // label 是语言的「自称」，缺失时退回 locale 本身，至少还能选
        label: contribution.label || contribution.locale,
        source,
        pluginId: manifest.id,
        dir,
        messages
      })

      logger.debug('Language pack registered', {
        locale: contribution.locale,
        pluginId: manifest.id,
        source,
        messages: Object.keys(messages).length
      })
    }

    return manifest
  }

  unload(pluginId: string): void {
    permissionManager.unregister(pluginId)
    uiRegistry.unregisterByPlugin(pluginId)
    settingsRegistry.unregisterByPlugin(pluginId)
    languagePackRegistry.unregisterByPlugin(pluginId)
    manifestNlsRegistry.unregisterByPlugin(pluginId)
  }
}
