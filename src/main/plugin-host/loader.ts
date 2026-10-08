import fs from 'node:fs'
import path from 'node:path'
import { normalizeLocale } from '@shared/i18n'
import { permissionManager } from './permission'
import { uiRegistry } from './ui-registry'
import { languagePackRegistry } from '../i18n'
import {
  DEFAULT_NLS_FILE,
  NLS_FILE_RE,
  manifestNlsRegistry,
  parsePlaceholder
} from '../i18n/manifest-nls'
import type { LocaleId, LocaleSourceTier, MessageTable } from '@shared/i18n'
import type { ManifestNlsTables } from '../i18n/manifest-nls'
import type { PluginManifest, ViewLocation } from '@shared/plugin-api'

/** 视图入口的默认约定：插件目录下的 src/ui/index.tsx */
export const DEFAULT_VIEW_ENTRY = 'src/ui/index.tsx'

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
    console.warn(`[plugin-host] view ${viewId} 使用了旧 location "${key}"，已映射为 "${legacy}"`)
    return legacy
  }

  console.warn(
    `[plugin-host] view ${viewId} 的 location "${key}" 不合法，已回落到 "${FALLBACK_LOCATION}"`
  )
  return FALLBACK_LOCATION
}

function toPosix(p: string): string {
  return p.replace(/\\/g, '/')
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
    console.warn(`[plugin-host] ${what} 的路径 "${relativePath}" 逃出了插件目录，已忽略`)
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
    console.error(`[plugin-host] 词条文件读取失败: ${absolutePath}`, err)
    return null
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.error(`[plugin-host] 词条文件必须是一个 JSON 对象: ${absolutePath}`)
    return null
  }

  const table: MessageTable = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      console.warn(`[plugin-host] 词条文件 ${absolutePath} 的 "${key}" 不是字符串，已跳过`)
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
    console.error(`[plugin-host] 无法读取插件目录以查找 manifest 词条: ${pluginDir}`, err)
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
  viewId: string,
  titleSpec: string,
  tables: ManifestNlsTables | null
): void {
  const key = parsePlaceholder(titleSpec)
  if (key === null) return

  if (!tables) {
    console.error(
      `[plugin-host] ${pluginId} 的视图 ${viewId} 用了占位符 %${key}%，但插件目录下既没有 ` +
        `${DEFAULT_NLS_FILE} 也没有 package.nls.<locale>.json，界面会显示原样占位符`
    )
    return
  }

  const inDefault = tables.defaultTable?.[key] !== undefined
  const inAnyLocale = Object.values(tables.byLocale).some((table) => table[key] !== undefined)

  if (!inDefault && !inAnyLocale) {
    console.error(
      `[plugin-host] ${pluginId} 的视图 ${viewId} 用了占位符 %${key}%，` +
        `但任何词条文件里都没有这个 key，界面会显示原样占位符`
    )
  }
}

export class PluginLoader {
  /**
   * 读取 manifest.json，注册权限、UI 视图贡献点与语言包。
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
      console.error(`[plugin-host] manifest 解析失败: ${manifestPath}`, err)
      return null
    }

    const pluginDir = path.dirname(manifestPath)
    const dir = path.basename(pluginDir)

    permissionManager.register(manifest.id, manifest.permissions ?? [])

    // manifest 文案的词条先读进来：下面注册视图时要拿它校验占位符能不能落地
    const nlsTables = readManifestNls(pluginDir)
    if (nlsTables) manifestNlsRegistry.register(manifest.id, nlsTables)

    for (const view of manifest.contributes?.views ?? []) {
      const entryAbs = path.resolve(pluginDir, view.entry ?? DEFAULT_VIEW_ENTRY)
      // 关键：只传「插件目录内的相对路径」——不含盘符、不依赖 cwd，
      // dev 与打包后的取值完全一致。
      const entry = toPosix(path.relative(pluginDir, entryAbs))

      const titleSpec = view.title ?? view.id
      warnUnresolvableTitle(manifest.id, view.id, titleSpec, nlsTables)

      uiRegistry.register({
        id: view.id,
        // 存原始值而不是解析结果：解析要用当前语言，而这里跑在 initI18n() 之前。
        // 真正解析发生在 host:get-plugin-views 被调用时，见 manifest-nls.ts
        titleSpec,
        location: normalizeLocation(view.location, view.id),
        icon: view.icon,
        pluginId: manifest.id,
        dir,
        entry
      })

      console.log(`[plugin-host] view registered: ${view.id} -> plugins/builtin/${dir}/${entry}`)
    }

    for (const contribution of manifest.contributes?.locales ?? []) {
      if (!contribution.locale || !contribution.file) {
        console.warn(`[plugin-host] ${manifest.id} 有一条 locales 缺少 locale 或 file，已跳过`)
        continue
      }

      const absolute = resolveInsidePlugin(
        pluginDir,
        contribution.file,
        `语言包 ${manifest.id}/${contribution.locale}`
      )
      if (!absolute) continue

      if (!fs.existsSync(absolute)) {
        console.error(
          `[plugin-host] 语言包文件不存在: ${absolute}（${manifest.id} 声明的是 "${contribution.file}"）`
        )
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

      console.log(
        `[plugin-host] language pack registered: ${contribution.locale} <- ${manifest.id}` +
          ` (${source}), ${Object.keys(messages).length} 条`
      )
    }

    return manifest
  }

  unload(pluginId: string): void {
    permissionManager.unregister(pluginId)
    uiRegistry.unregisterByPlugin(pluginId)
    languagePackRegistry.unregisterByPlugin(pluginId)
    manifestNlsRegistry.unregisterByPlugin(pluginId)
  }
}
