import fs from 'node:fs'
import path from 'node:path'
import {
  PLUGIN_PREFERENCE_FILE_NAME,
  emptyPluginPreference,
  parsePluginPreference,
  setPluginEnabled as applyPluginEnabled
} from '../../../../src/shared/plugin-api/preference.ts'
import { isReservedHostId } from '../../../../src/shared/plugin-api/view.ts'
import { emptyPluginContributions } from '../../../../src/shared/plugin-api/contributions.ts'
import { readPluginContributions } from './plugin-contributions.ts'
import type { PluginContributionSet } from './plugin-contributions.ts'
import type { PluginPreference } from '../../../../src/shared/plugin-api/preference.ts'
import type { ClientBundleDescriptor } from '../../../../src/shared/plugin-api/client-bundle.ts'
import type { PluginContributions } from '../../../../src/shared/plugin-api/contributions.ts'
import type {
  PluginDescriptor,
  PluginInstallResult,
  PluginRemoveResult
} from '../../../../src/shared/plugin-api/plugin.ts'

/**
 * 插件目录的发现、清单、启用状态与**贡献点**（host 侧）。
 *
 * 这一层现在是插件目录的**唯一**读取方：
 * - 清单（装了哪些、哪个启用、浏览器半在哪）；
 * - 视图 / 设置页 / 语言包 / manifest 词条（见 plugin-contributions.ts）。
 *
 * shell 不再扫插件目录：它要的东西全部由 `plugins.*` 下发。标题的解析仍在 shell
 * —— 那要用当前语言，而语言属于 shell 的 i18n（`src/main/i18n`）。
 *
 * 两个目录：
 * - `<appRoot>/plugins/builtin`：随宿主分发，不能卸载；
 * - `<userData>/plugins`：用户安装的第三方插件。
 *
 * 启用状态存 `plugin-preferences.json`（userData），只有被显式禁用的 id 才落盘；
 * 没有记录一律视为启用（见 shared/plugin-api/preference）。
 */

export type PluginSource = 'builtin' | 'third-party'

interface CatalogEntry {
  descriptor: PluginDescriptor
  source: PluginSource
  /** 插件目录的绝对路径；只在 host 内用来解析 bundle，不进 descriptor */
  dirPath: string
  client?: { platform: 'web'; bundle: string }
  /** 视图 / 设置页 / 语言包 / manifest 词条，扫目录时一并读好 */
  contributions: PluginContributionSet
}

export interface PluginManagerOptions {
  /** `<appRoot>/plugins/builtin` */
  builtinDir: string
  /** `<userData>/plugins` */
  thirdPartyDir: string
  /** `<userData>/plugin-preferences.json` */
  preferencePath: string
}

function warn(message: string, fields?: Record<string, unknown>): void {
  if (fields) console.warn(`[nide-host] ${message}`, fields)
  else console.warn(`[nide-host] ${message}`)
}

function info(message: string, fields?: Record<string, unknown>): void {
  if (fields) console.info(`[nide-host] ${message}`, fields)
  else console.info(`[nide-host] ${message}`)
}

function normalizeId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

/** manifest 里 `client.bundle` 能不能安全地解析到插件目录之内 */
function resolveInside(pluginDir: string, relativePath: string): string | null {
  const absolute = path.resolve(pluginDir, relativePath)
  const relative = path.relative(pluginDir, absolute)

  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return absolute
}

/** 把一份手写 manifest 收敛成一个插件条目；不合法时给 null（整份忽略） */
function toEntry(raw: unknown, source: PluginSource, dirPath: string): CatalogEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn('Plugin manifest must be a JSON object', { dir: dirPath })
    return null
  }

  const manifest = raw as {
    id?: unknown
    name?: unknown
    version?: unknown
    permissions?: unknown
    requiresRestart?: unknown
    description?: unknown
    client?: unknown
    contributes?: unknown
  }

  const id = normalizeId(manifest.id)
  const name = normalizeId(manifest.name)
  const version = normalizeId(manifest.version)

  if (id.length === 0 || name.length === 0 || version.length === 0) {
    warn('Plugin manifest is missing id / name / version', { dir: dirPath })
    return null
  }

  // 宿主命名空间是保留的：放过去就等于让插件顶掉内建视图 / 设置页
  if (isReservedHostId(id)) {
    warn('Plugin id claims the host namespace, the plugin is ignored', { id, dir: dirPath })
    return null
  }

  /**
   * 视图清单（清单展示用）取自同一份贡献点，不再单独解析一遍 manifest：
   * 两处各读一次是上一轮「两个加载器对不上」的根源。
   */
  const contributions = readPluginContributions({
    pluginDir: dirPath,
    pluginId: id,
    source,
    contributes: manifest.contributes
  })
  // 保留 id 已在上面拒绝；这里只是把「读不出来」当成整份忽略，与旧行为一致
  if (!contributions) return null

  const views = contributions.views.map((view) => view.id)

  const permissions = Array.isArray(manifest.permissions)
    ? manifest.permissions.filter(
        (permission): permission is string => typeof permission === 'string'
      )
    : []

  let client: { platform: 'web'; bundle: string } | undefined
  if (manifest.client && typeof manifest.client === 'object') {
    const candidate = manifest.client as { platform?: unknown; bundle?: unknown }
    if (candidate.platform === 'web' && typeof candidate.bundle === 'string') {
      const resolved = resolveInside(dirPath, candidate.bundle)
      if (resolved) client = { platform: 'web', bundle: candidate.bundle }
      else warn('Plugin client bundle escapes the plugin directory, ignored', { id, dir: dirPath })
    }
  }

  return {
    source,
    dirPath,
    contributions,
    ...(client ? { client } : {}),
    descriptor: {
      id,
      name,
      version,
      builtin: source === 'builtin',
      dir: path.basename(dirPath),
      permissions,
      views,
      requiresRestart: manifest.requiresRestart === true,
      ...(typeof manifest.description === 'string' && manifest.description.length > 0
        ? { description: manifest.description }
        : {})
    }
  }
}

function scanDir(dir: string, source: PluginSource): CatalogEntry[] {
  if (!fs.existsSync(dir)) return []

  const entries: CatalogEntry[] = []

  for (const name of fs.readdirSync(dir)) {
    const pluginDir = path.join(dir, name)
    const manifestPath = path.join(pluginDir, 'manifest.json')
    if (!fs.existsSync(manifestPath)) continue

    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    } catch (error) {
      warn('Failed to parse the plugin manifest', { file: manifestPath, error })
      continue
    }

    const entry = toEntry(raw, source, pluginDir)
    if (entry) entries.push(entry)
  }

  return entries
}

export class PluginManager {
  private readonly options: PluginManagerOptions
  private entries = new Map<string, CatalogEntry>()
  private preference: PluginPreference

  constructor(options: PluginManagerOptions) {
    this.options = options
    this.preference = this.readPreference()
    this.scan()
  }

  private readPreference(): PluginPreference {
    try {
      const raw = JSON.parse(fs.readFileSync(this.options.preferencePath, 'utf-8'))
      return parsePluginPreference(raw)
    } catch {
      // 首次启动（文件不存在）与文件损坏同一条：空偏好不是错误
      return emptyPluginPreference()
    }
  }

  private persist(next: PluginPreference): void {
    this.preference = next

    try {
      fs.mkdirSync(path.dirname(this.options.preferencePath), { recursive: true })
      fs.writeFileSync(this.options.preferencePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
    } catch (error) {
      // 写不进去只影响「下次启动还记得」，本次运行内状态仍然生效
      warn('Failed to write the plugin preference', { error })
    }
  }

  /** 重新扫描两个插件目录；后扫到的同名 id 覆盖先扫到的（第三方覆盖内置） */
  scan(): void {
    const next = new Map<string, CatalogEntry>()

    for (const entry of scanDir(this.options.builtinDir, 'builtin')) {
      next.set(entry.descriptor.id, entry)
    }
    for (const entry of scanDir(this.options.thirdPartyDir, 'third-party')) {
      next.set(entry.descriptor.id, entry)
    }

    this.entries = next
    info('Plugin directories scanned', {
      builtin: this.options.builtinDir,
      thirdParty: this.options.thirdPartyDir,
      count: next.size
    })
  }

  /** 已发现的插件（纯数据，按名称排序，与设置页的显示顺序一致） */
  list(): PluginDescriptor[] {
    return Array.from(this.entries.values())
      .map((entry) => entry.descriptor)
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
  }

  /** 被禁用的插件 id */
  disabled(): string[] {
    return [...this.preference.disabled]
  }

  /** 启用 / 禁用并落盘；没有实际变化时不写盘 */
  setEnabled(pluginId: string, enabled: boolean): void {
    const next = applyPluginEnabled(this.preference, pluginId, enabled)
    if (next === this.preference) return

    this.persist(next)
    info('Plugin preference updated', { pluginId, enabled })
  }

  /**
   * 从一个目录安装插件：校验 manifest -> 复制到 `<userData>/plugins/<目录名>` ->
   * 重新扫描 -> **默认禁用**。
   *
   * 默认禁用是刻意的（D6）：第三方代码拥有完整 Node 权限，装进来不等于用户同意
   * 让它跑。启用前还要过一道信任确认（在 shell 侧）。
   *
   * 不覆盖任何东西：目标目录或同名插件 id 已存在时直接拒绝。
   */
  install(sourceDir: string): PluginInstallResult {
    const source = path.resolve(String(sourceDir ?? ''))
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
      return { ok: false, reason: 'invalid-plugin' }
    }

    const manifestPath = path.join(source, 'manifest.json')
    if (!fs.existsSync(manifestPath)) return { ok: false, reason: 'invalid-plugin' }

    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    } catch (error) {
      warn('Failed to parse the plugin manifest being installed', { file: manifestPath, error })
      return { ok: false, reason: 'invalid-plugin' }
    }

    const candidate = toEntry(raw, 'third-party', source)
    if (!candidate) return { ok: false, reason: 'invalid-plugin' }

    if (this.entries.has(candidate.descriptor.id)) return { ok: false, reason: 'already-exists' }

    // 不允许把「已经装好的插件目录」再装一遍（复制到自身会先删除原目录）
    const relativeSource = path.relative(this.options.thirdPartyDir, source)
    if (
      relativeSource === '' ||
      (!relativeSource.startsWith('..') && !path.isAbsolute(relativeSource))
    ) {
      return { ok: false, reason: 'invalid-plugin' }
    }

    const dirName = path.basename(source)
    const target = path.join(this.options.thirdPartyDir, dirName)
    if (fs.existsSync(target)) return { ok: false, reason: 'already-exists' }

    try {
      fs.mkdirSync(this.options.thirdPartyDir, { recursive: true })
      fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false })
    } catch (error) {
      fs.rmSync(target, { recursive: true, force: true })
      warn('Failed to copy a plugin into the third-party directory', { source, target, error })
      return { ok: false, reason: 'unreadable' }
    }

    this.scan()

    const installed = this.entries.get(candidate.descriptor.id)
    if (!installed) {
      // 复制成功但扫描不到：manifest 在复制过程中坏了，或目录名/权限有问题
      fs.rmSync(target, { recursive: true, force: true })
      this.scan()
      return { ok: false, reason: 'invalid-plugin' }
    }

    // 默认禁用：装进来只是「有了」，还没有被信任
    this.setEnabled(installed.descriptor.id, false)

    info('Plugin installed', { pluginId: installed.descriptor.id, dir: dirName })
    return { ok: true, plugin: installed.descriptor }
  }

  /**
   * 卸载一个第三方插件：删掉它的目录并重新扫描。
   *
   * 内置插件不能卸载；第三方也只在目录确实位于 `<userData>/plugins` 之内时才删。
   */
  remove(pluginId: string): PluginRemoveResult {
    const id = normalizeId(pluginId)
    const entry = this.entries.get(id)
    if (!entry) return { ok: false, reason: 'not-found' }
    if (entry.source !== 'third-party') return { ok: false, reason: 'builtin' }

    const relative = path.relative(this.options.thirdPartyDir, entry.dirPath)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return { ok: false, reason: 'unreadable' }
    }

    try {
      fs.rmSync(entry.dirPath, { recursive: true, force: true })
    } catch (error) {
      warn('Failed to remove a plugin directory', { pluginId: id, dir: entry.dirPath, error })
      return { ok: false, reason: 'unreadable' }
    }

    this.scan()
    info('Plugin removed', { pluginId: id })
    return { ok: true, plugin: entry.descriptor }
  }

  /**
   * 已启用插件的浏览器半清单。
   *
   * 绝对路径只用于开发期的 Vite `/@fs/`；生产环境会换成 app 协议（见
   * docs/architecture/plugin-ui-bundles.md）。
   */
  clientBundles(): ClientBundleDescriptor[] {
    const disabled = new Set(this.preference.disabled)

    return Array.from(this.entries.values()).flatMap((entry) => {
      if (!entry.client || disabled.has(entry.descriptor.id)) return []
      return [
        {
          pluginId: entry.descriptor.id,
          platform: entry.client.platform,
          bundlePath: path.resolve(entry.dirPath, entry.client.bundle)
        }
      ]
    })
  }

  /**
   * 全部插件的贡献点，按扫描顺序拼接（内置在前、第三方在后）。
   *
   * 启用状态**不在这里过滤**：视图列表由渲染进程按禁用集合过滤，设置页由 shell
   * 过滤 —— 那一侧的现有行为就是「先拿全量、再按需筛」，这里跟着它，免得同一条
   * 规则在两个地方各写一遍。
   */
  contributions(): PluginContributions {
    const result = emptyPluginContributions()

    for (const entry of this.entries.values()) {
      const { views, settings, locales, manifestNls } = entry.contributions
      result.views.push(...views)
      result.settings.push(...settings)
      result.locales.push(...locales)
      if (manifestNls) result.manifestNls[entry.descriptor.id] = manifestNls
    }

    return result
  }
}

/** 默认的偏好文件路径：`<userData>/plugin-preferences.json` */
export function pluginPreferencePath(userDataDir: string): string {
  return path.join(userDataDir, PLUGIN_PREFERENCE_FILE_NAME)
}
