import fs from 'node:fs'
import path from 'node:path'
import {
  PLUGIN_PREFERENCE_FILE_NAME,
  emptyPluginPreference,
  isPluginEnabled,
  parsePluginPreference,
  setPluginEnabled as applyPluginEnabled
} from '../../../../packages/contracts/src/plugin-api/preference.ts'
import { isReservedHostId } from '../../../../packages/contracts/src/plugin-api/view.ts'
import { emptyPluginContributions } from '../../../../packages/contracts/src/plugin-api/contributions.ts'
import { parsePluginPermissions } from '../../../../packages/contracts/src/plugin-api/permissions.ts'
import { readPluginContributions } from './plugin-contributions.ts'
import type { PluginContributionSet } from './plugin-contributions.ts'
import type {
  PluginPreference,
  PluginEnabledFlags
} from '../../../../packages/contracts/src/plugin-api/preference.ts'
import type { ClientBundleDescriptor } from '../../../../packages/contracts/src/plugin-api/client-bundle.ts'
import type { PluginPermissions } from '../../../../packages/contracts/src/plugin-api/permissions.ts'
import type {
  PluginContributions,
  PluginManifestNls
} from '../../../../packages/contracts/src/plugin-api/contributions.ts'
import type { PluginSettingsDescriptor } from '../../../../packages/contracts/src/plugin-api/manifest.ts'
import type { PluginViewDescriptor } from '../../../../packages/contracts/src/plugin-api/view.ts'
import type {
  PluginDescriptor,
  PluginInstallResult,
  PluginRemoveResult
} from '../../../../packages/contracts/src/plugin-api/plugin.ts'

/**
 * 把一个贡献点的标题解析成当前语言的文案。
 *
 * 由 host 的入口注入（它持有 `HostI18n` 与当前 locale）—— `PluginManager` 不认识
 * 语言，只认识「有个函数能把这个 `%key%` 变成人话」。
 */
export type TitleResolver = (pluginId: string, titleSpec: string, fallback: string) => string

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
  /** 主进程入口的绝对路径（manifest.main，已确认在插件目录内且文件存在） */
  entryMain?: string
  /** 卸载脚本的绝对路径（manifest.uninstall，只有带 main 的插件才认） */
  entryUninstall?: string
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

/** 激活事件形状：与 mics 一致 */
const ACTIVATION_PATTERN = /^(\*|onStartup|onView:.+|onCommand:.+)$/

/** 解析 `activation`（也接受旧的 `activationEvents`）；非法项只警告 */
function parseActivation(raw: unknown, id: string, dir: string): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    warn('Plugin activation must be an array', { id, dir })
    return []
  }

  const events: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || !ACTIVATION_PATTERN.test(item)) {
      warn('Unknown plugin activation event, ignored', { id, dir, event: item })
      continue
    }
    if (!events.includes(item)) events.push(item)
  }
  return events
}

/** 依赖：只认非空字符串；自依赖与重复项直接丢掉 */
function parseDependencies(raw: unknown, id: string, dir: string): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) {
    warn('Plugin dependencies must be an array of plugin ids', { id, dir })
    return []
  }

  const dependencies: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      warn('Invalid plugin dependency, ignored', { id, dir, dependency: item })
      continue
    }
    const dependency = item.trim()
    if (dependency === id) {
      warn('Plugin depends on itself, ignored', { id, dir })
      continue
    }
    if (!dependencies.includes(dependency)) dependencies.push(dependency)
  }
  return dependencies
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
    main?: unknown
    uninstall?: unknown
    activation?: unknown
    activationEvents?: unknown
    dependencies?: unknown
    core?: unknown
    essential?: unknown
    experimental?: unknown
    defaultDisabled?: unknown
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

  /**
   * 权限声明在这里就归一化：运行时的权限表（permissions.ts）只认 v2 对象。
   * 声明写错时**整份拒绝** —— 把 `{ trust: 'sandboxed', fs: ... }` 的拼写错误降级成
   * full 等于悄悄放开它没声明的能力，比加载失败糟得多。
   */
  const parsedPermissions = parsePluginPermissions(manifest.permissions, {
    context: `${id} 的 permissions`
  })
  for (const warning of parsedPermissions.warnings) warn(warning, { id, dir: dirPath })
  if (!parsedPermissions.permissions) {
    warn('Plugin permissions are invalid, the plugin is ignored', {
      id,
      dir: dirPath,
      errors: parsedPermissions.errors
    })
    return null
  }
  const permissions: PluginPermissions = parsedPermissions.permissions

  let client: { platform: 'web'; bundle: string } | undefined
  if (manifest.client && typeof manifest.client === 'object') {
    const candidate = manifest.client as { platform?: unknown; bundle?: unknown }
    if (candidate.platform === 'web' && typeof candidate.bundle === 'string') {
      const resolved = resolveInside(dirPath, candidate.bundle)
      if (resolved) client = { platform: 'web', bundle: candidate.bundle }
      else warn('Plugin client bundle escapes the plugin directory, ignored', { id, dir: dirPath })
    }
  }

  /**
   * 主进程入口。
   *
   * 与渲染半同样的路径守卫：必须是插件目录内、且文件真的存在。声明了却找不到
   * 文件时**不拒绝整个插件**（视图/设置页还能用），只记一条日志并当作没有后端。
   */
  let entryMain: string | undefined
  if (manifest.main !== undefined) {
    if (typeof manifest.main !== 'string' || manifest.main.trim().length === 0) {
      warn('Plugin main must be a non-empty relative path', { id, dir: dirPath })
    } else {
      const resolved = resolveInside(dirPath, manifest.main)
      if (!resolved) {
        warn('Plugin main escapes the plugin directory, the backend is ignored', {
          id,
          dir: dirPath
        })
      } else if (!fs.existsSync(resolved)) {
        warn('Plugin main does not exist on disk, the backend is ignored', {
          id,
          dir: dirPath,
          main: manifest.main
        })
      } else {
        entryMain = resolved
      }
    }
  }

  /** 卸载脚本：同样是插件目录内的文件，只有后端插件才能声明（页面插件没有清理权限） */
  let entryUninstall: string | undefined
  if (manifest.uninstall !== undefined) {
    const resolved =
      typeof manifest.uninstall === 'string' ? resolveInside(dirPath, manifest.uninstall) : null
    if (!resolved || !fs.existsSync(resolved)) {
      warn('Plugin uninstall script is invalid or missing, ignored', {
        id,
        dir: dirPath,
        uninstall: manifest.uninstall
      })
    } else if (!entryMain) {
      warn('Plugin uninstall script requires a main entry, ignored', { id, dir: dirPath })
    } else {
      entryUninstall = resolved
    }
  }

  const activation = parseActivation(manifest.activation ?? manifest.activationEvents, id, dirPath)
  const dependencies = parseDependencies(manifest.dependencies, id, dirPath)

  return {
    source,
    dirPath,
    contributions,
    ...(client ? { client } : {}),
    ...(entryMain ? { entryMain } : {}),
    ...(entryUninstall ? { entryUninstall } : {}),
    descriptor: {
      id,
      name,
      version,
      builtin: source === 'builtin',
      dir: path.basename(dirPath),
      permissions,
      hasBackend: entryMain !== undefined,
      hasUninstall: entryUninstall !== undefined,
      activation,
      dependencies,
      core: manifest.core === true,
      essential: manifest.essential === true,
      experimental: manifest.experimental === true,
      defaultDisabled: manifest.defaultDisabled === true,
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
    // `.staging`（安装事务的暂存目录）不是插件，别去它的子目录里找 manifest
    if (name.startsWith('.')) continue

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

  /**
   * 一个插件的权限声明（已归一化）。未知 id 返回 undefined —— 调用方据此拒绝
   * 来自「已经被卸载的插件」的残留调用。
   */
  permissionsOf(pluginId: string): PluginPermissions | undefined {
    return this.entries.get(pluginId)?.descriptor.permissions
  }

  /**
   * 权限检查需要的目录信息。
   *
   * 只给宿主内部用（`${pluginDir}` 的展开与日志），不进任何 RPC 返回值。
   */
  locationOf(pluginId: string): { dirPath: string; source: PluginSource } | undefined {
    const entry = this.entries.get(pluginId)
    return entry ? { dirPath: entry.dirPath, source: entry.source } : undefined
  }

  /** 主进程入口的绝对路径；没有后端返回 undefined */
  backendEntryOf(pluginId: string): string | undefined {
    return this.entries.get(pluginId)?.entryMain
  }

  /** 卸载脚本的绝对路径；没有返回 undefined */
  uninstallEntryOf(pluginId: string): string | undefined {
    return this.entries.get(pluginId)?.entryUninstall
  }

  /** 清单描述符；未知 id 返回 undefined */
  pluginOf(pluginId: string): PluginDescriptor | undefined {
    return this.entries.get(pluginId)?.descriptor
  }

  /** 某个视图贡献属于哪个插件；没有返回 undefined */
  viewOwner(viewId: string): string | undefined {
    for (const entry of this.entries.values()) {
      if (entry.contributions.views.some((view) => view.id === viewId)) {
        return entry.descriptor.id
      }
    }
    return undefined
  }

  /** 清单里影响默认启用状态的标记 */
  private flagsOf(pluginId: string): PluginEnabledFlags {
    const descriptor = this.entries.get(pluginId)?.descriptor
    if (!descriptor) return {}
    return {
      core: descriptor.core,
      essential: descriptor.essential,
      defaultDisabled: descriptor.defaultDisabled
    }
  }

  /** 当前是否启用（core / essential 恒启用；其余看偏好与清单默认值） */
  isEnabled(pluginId: string): boolean {
    return isPluginEnabled(this.preference, pluginId, this.flagsOf(pluginId))
  }

  /** 当前**实际**被禁用的插件 id（包含默认禁用且用户没有显式启用的） */
  disabled(): string[] {
    return this.list()
      .map((plugin) => plugin.id)
      .filter((pluginId) => !this.isEnabled(pluginId))
      .sort()
  }

  /** 用户显式启用过的插件 id（设置页判断「默认禁用插件是否已被打开」用） */
  explicitlyEnabled(): string[] {
    return [...this.preference.enabled]
  }

  /** 启用 / 禁用并落盘；core / essential 拒绝改动；没有实际变化时不写盘 */
  setEnabled(pluginId: string, enabled: boolean): void {
    const next = applyPluginEnabled(this.preference, pluginId, enabled, this.flagsOf(pluginId))
    if (next === this.preference) return

    this.persist(next)
    info('Plugin preference updated', { pluginId, enabled })
  }

  /**
   * 从一个目录安装 / 升级插件。
   *
   * 事务顺序（与 mics 一致）：复制到 `.staging` → 在暂存目录里重新校验 → 旧版本
   * 让位 → 原子 rename → 删除备份。任何一步失败都会清理暂存目录并恢复旧版本，
   * 所以升级失败不会把用户已装的插件弄丢。
   *
   * 新装默认禁用（D6）：装进来只是「有了」，还没有被信任；升级保留原来的启用状态。
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

    // 不允许把「已经装好的插件目录」再装一遍（复制到自身会先删除原目录）
    const relativeSource = path.relative(this.options.thirdPartyDir, source)
    if (
      relativeSource === '' ||
      (!relativeSource.startsWith('..') && !path.isAbsolute(relativeSource))
    ) {
      return { ok: false, reason: 'invalid-plugin' }
    }

    const pluginId = candidate.descriptor.id
    const existing = this.entries.get(pluginId)
    if (existing && existing.source !== 'third-party')
      return { ok: false, reason: 'already-exists' }

    const dirName = existing ? path.basename(existing.dirPath) : path.basename(source)
    const target = path.join(this.options.thirdPartyDir, dirName)
    const stagingRoot = path.join(this.options.thirdPartyDir, '.staging')
    const stamp = Date.now().toString(36)
    const staging = path.join(stagingRoot, `${dirName}.${stamp}`)
    const backup = path.join(stagingRoot, `${dirName}.old.${stamp}`)
    const wasEnabled = existing ? this.isEnabled(pluginId) : false

    try {
      fs.mkdirSync(stagingRoot, { recursive: true })
      fs.rmSync(staging, { recursive: true, force: true })
      fs.cpSync(source, staging, { recursive: true, errorOnExist: true, force: false })
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true })
      warn('Failed to copy a plugin into the staging directory', { source, staging, error })
      return { ok: false, reason: 'unreadable' }
    }

    try {
      // 在暂存目录里再校验一次：复制过程中坏掉 / 换 id 都挡在这里
      const stagedRaw = JSON.parse(
        fs.readFileSync(path.join(staging, 'manifest.json'), 'utf-8')
      ) as unknown
      const staged = toEntry(stagedRaw, 'third-party', staging)
      if (!staged || staged.descriptor.id !== pluginId) {
        throw new Error('staged manifest is not the same plugin')
      }

      const hadTarget = fs.existsSync(target)
      if (hadTarget) fs.renameSync(target, backup)

      try {
        fs.renameSync(staging, target)
      } catch (error) {
        if (hadTarget) fs.renameSync(backup, target)
        throw error
      }

      this.scan()
      const installed = this.entries.get(pluginId)
      if (!installed) throw new Error('installed plugin is not visible after rescanning')

      fs.rmSync(backup, { recursive: true, force: true })
      try {
        // 暂存根目录空了就一起收掉；非空说明另一个安装还在用
        fs.rmdirSync(stagingRoot)
      } catch {
        // ignore
      }

      if (!existing) {
        // 新装：默认禁用（装进来只是「有了」）
        this.setEnabled(pluginId, false)
      } else if (wasEnabled) {
        // 升级：保持原来的启用状态
        this.setEnabled(pluginId, true)
      }

      info('Plugin installed', {
        pluginId,
        dir: dirName,
        upgraded: existing !== undefined
      })
      return { ok: true, plugin: this.entries.get(pluginId)!.descriptor }
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true })
      // 目标已经被换成新的：回滚旧版本，避免留下一个半成品
      if (fs.existsSync(backup) && !fs.existsSync(target)) {
        try {
          fs.renameSync(backup, target)
        } catch (restoreError) {
          warn('Failed to restore the previous plugin version', { pluginId, error: restoreError })
        }
      }
      fs.rmSync(backup, { recursive: true, force: true })
      try {
        fs.rmdirSync(stagingRoot)
      } catch {
        // ignore
      }
      this.scan()
      warn('Failed to install a plugin', { source, target, error })
      return { ok: false, reason: 'invalid-plugin' }
    }
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
   * 两个过滤，缺一不可：
   * - 被禁用的插件不给：装了不等于同意让它跑；
   * - **文件不存在的不给**：manifest 声明了 `client` 但作者没构建（或打包时漏了
   *   `dist/`）时，回一份指向空气的清单只会让渲染进程去请求一个必然 404 的 URL。
   *   不返回它，`PluginSlot` 就会安静地回退到构建期 glob。
   */
  clientBundles(): ClientBundleDescriptor[] {
    const disabled = new Set(this.preference.disabled)

    return Array.from(this.entries.values()).flatMap((entry) => {
      if (!entry.client || disabled.has(entry.descriptor.id)) return []

      const bundlePath = path.resolve(entry.dirPath, entry.client.bundle)
      if (!fs.existsSync(bundlePath)) {
        warn('Plugin client bundle is declared but missing, ignored', {
          pluginId: entry.descriptor.id,
          bundlePath
        })
        return []
      }

      return [{ pluginId: entry.descriptor.id, platform: entry.client.platform, bundlePath }]
    })
  }

  /**
   * 全部插件的贡献点，按扫描顺序拼接（内置在前、第三方在后）。
   *
   * shell 已经不再消费它（视图 / 设置页改为由下面两个方法直接给**已解析标题**的
   * 描述符），留着是因为它是语言包集合的来源（`HostI18n.setPacks`）与内部聚合点。
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

  /** 某个插件的 manifest 词条表；没有就是没做本地化 */
  manifestNls(pluginId: string): PluginManifestNls | undefined {
    return this.entries.get(pluginId)?.contributions.manifestNls
  }

  /**
   * 视图表：给渲染进程的**纯数据**，标题已按当前语言解析。
   *
   * 内建视图（文件树等）不在这里 —— 它们的标题是宿主的词条，只有 shell 有 `t()`
   * （词条表在 shell 缓存着），所以由 shell 拼在前面，顺序仍是「内建在前」。
   */
  views(resolve: TitleResolver): PluginViewDescriptor[] {
    return Array.from(this.entries.values()).flatMap((entry) =>
      entry.contributions.views.map((view) => ({
        id: view.id,
        title: resolve(view.pluginId, view.titleSpec, view.id),
        location: view.location,
        ...(view.icon ? { icon: view.icon } : {}),
        ...(view.chrome ? { chrome: view.chrome } : {}),
        pluginId: view.pluginId,
        dir: view.dir,
        entry: view.entry
      }))
    )
  }

  /**
   * 设置页：同样已解析标题，并且**滤掉被禁用插件**的页。
   *
   * 过滤放在这里而不是 shell：禁用集合就存在 host（与 `plugins.disabled` 同一份），
   * 让消费方再筛一遍只会多一条会走样的规则。
   */
  settings(resolve: TitleResolver): PluginSettingsDescriptor[] {
    const disabled = new Set(this.preference.disabled)

    return Array.from(this.entries.values())
      .filter((entry) => !disabled.has(entry.descriptor.id))
      .flatMap((entry) =>
        entry.contributions.settings.map((page) => ({
          id: page.id,
          pluginId: page.pluginId,
          title: resolve(page.pluginId, page.titleSpec, page.id),
          dir: page.dir,
          entry: page.entry,
          order: page.order
        }))
      )
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
  }
}

/** 默认的偏好文件路径：`<userData>/plugin-preferences.json` */
export function pluginPreferencePath(userDataDir: string): string {
  return path.join(userDataDir, PLUGIN_PREFERENCE_FILE_NAME)
}
