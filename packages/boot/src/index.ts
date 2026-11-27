import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { hostServices, type InstallOptions } from '@nide/kernel/context.ts'
import { applyPatches, toPatchOperations, type PatchOperation, type PatchRow } from './patch.ts'

/**
 * NIDE profile 启动层。
 *
 * 职责：
 * 1. 找到 / 初始化 NIDE_HOME 下的 profile；
 * 2. 按「bundle 层 → cordis.yml → cordis.patch.yml」合成行表（见 `patch.ts`）；
 * 3. 用 DSH 的 loader 逐行导入插件，并等它们真的激活。
 *
 * 仍然是 MVP 的部分（待补）：
 * - `!!js` 表达式与按环境求值的 `disabled`
 * - required 启动审计（现在只等 15s 并列出卡住的条目）
 * - runtime resolution：从 profile/node_modules 解析包标识符
 * - 模块热替换与重载
 */

export type ProfileRow = PatchRow

export interface NidePaths {
  home: string
  profileName: string
  profileDir: string
}

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** packages/boot/src -> 仓库根 */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..')

/** NIDE_HOME：默认 ~/.nide，测试时用 NIDE_HOME 指到工作区内。 */
export function resolveHome(): string {
  const fromEnv = process.env.NIDE_HOME?.trim()
  return fromEnv && fromEnv.length > 0 ? path.resolve(fromEnv) : path.join(os.homedir(), '.nide')
}

/** 读 profile 目录里的模板版本；没有 `profile.json` 视为 1（迁移期的老 profile） */
function readProfileVersion(dir: string): number {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof raw.version === 'number' ? raw.version : 1
  } catch {
    return 1
  }
}

function writeProfileVersion(dir: string, version: number): void {
  const target = path.join(dir, 'profile.json')
  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8')) as Record<string, unknown>
    raw.version = version
    fs.writeFileSync(
      target,
      `${JSON.stringify(raw, null, 2)}
`,
      'utf8'
    )
  } catch {
    fs.writeFileSync(
      target,
      `${JSON.stringify({ version }, null, 2)}
`,
      'utf8'
    )
  }
}

export function resolveProfile(name: string): NidePaths {
  const home = resolveHome()
  return {
    home,
    profileName: name,
    profileDir: path.join(home, 'profiles', name)
  }
}

/**
 * profile 模板版本。
 *
 * 模板内容现在由代码生成（仓库里没有 `profiles/` 目录，和 DSH 一样：profile 是
 * 运行时产物，落在 `NIDE_HOME/profiles/<name>`）。改下面的常量时把它 +1，
 * 老用户机器上的 `cordis.yml` 会在下次启动刷新（旧的备份成 `.bak`）。
 */
const PROFILE_TEMPLATE_VERSION = 4

/** 模板 package.json：唯一的装配信息是 bundle 列表 */
const PROFILE_PACKAGE: Record<string, unknown> = {
  name: 'nide-profile-desktop',
  private: true,
  type: 'module',
  description: 'NIDE desktop profile: bundle layers + profile rows + user patch.',
  nide: {
    profile: {
      bundles: ['{{NIDE_ROOT}}/packages/bundle/base']
    }
  }
}

/** 模板 `cordis.yml`：profile 自己的行（宿主服务在 bundle 层） */
const PROFILE_CORDIS_YML = `# NIDE desktop profile root config。
#
# 装配分三层，后写的赢（见 packages/boot/src/patch.ts）：
#   1. package.json 的 nide.profile.bundles —— 组合包（当前是 @nide/bundle-base）
#   2. 本文件 —— profile 自己的行
#   3. cordis.patch.yml —— 用户覆盖（按 id 改 config / disabled，或 insert 新行）
#
# 这个文件由宿主在首次启动时生成；改模板规则见 packages/boot/src/index.ts。
- id: hello
  name: '{{NIDE_ROOT}}/packages/hello/src/index.ts'
  config:
    greeting: 'nide host skeleton is alive'
`

/** 模板 `cordis.patch.yml`：空数组是合法的，空文件会被 loader 判为错误 */
const PROFILE_PATCH_YML = `# 用户覆盖层（schema 与 DSH 一致：顶层是 patch 数组）。
# 空数组是合法的；空文件会被 loader 判为错误，所以不要清空这个文件。
[]
`

/**
 * 首次启动时**生成** profile（不再从仓库模板复制）。
 *
 * 只补缺失的文件，不覆盖已有的 cordis.yml / patch —— 用户手改过的配置不能被启动
 * 流程盖掉。模板版本更新时刷新 `cordis.yml`（旧文件备份成 `.bak`）。
 * `reset=true` 会先删掉整个 profile（只给开发脚本用）。
 */
export function ensureProfile(paths: NidePaths, reset = false): void {
  if (reset && fs.existsSync(paths.profileDir)) {
    fs.rmSync(paths.profileDir, { recursive: true, force: true })
  }

  fs.mkdirSync(paths.profileDir, { recursive: true })

  const localVersion = readProfileVersion(paths.profileDir)
  const upgrading = PROFILE_TEMPLATE_VERSION > localVersion

  writeIfMissing(
    path.join(paths.profileDir, 'package.json'),
    `${JSON.stringify(PROFILE_PACKAGE, null, 2)}\n`
  )
  writeIfMissing(path.join(paths.profileDir, 'cordis.patch.yml'), PROFILE_PATCH_YML)

  /**
   * `cordis.yml` 是装配点：模板版本更新时覆盖（旧文件备份），否则只补缺失。
   */
  const cordis = path.join(paths.profileDir, 'cordis.yml')
  if (upgrading && fs.existsSync(cordis)) {
    fs.cpSync(cordis, `${cordis}.bak`, { force: true })
  }
  if (upgrading || !fs.existsSync(cordis)) {
    fs.writeFileSync(cordis, PROFILE_CORDIS_YML, 'utf8')
  }

  if (upgrading) writeProfileVersion(paths.profileDir, PROFILE_TEMPLATE_VERSION)
  fs.mkdirSync(path.join(paths.profileDir, 'node_modules'), { recursive: true })

  /**
   * 既有 profile 的 `package.json` 不会因为模板升级被覆盖（那是用户的地盘），
   * 但 `nide.profile.bundles` 是**装配点的一部分**：模板加了 bundle 之后，老机器
   * 上那份还是空数组，服务就会缺。这里只补「本地没有声明」的情况。
   */
  mergeProfileBundles(PROFILE_PACKAGE, paths.profileDir)
}

/** 写文件，已存在则跳过（启动流程不覆盖用户配置） */
function writeIfMissing(file: string, content: string): void {
  if (fs.existsSync(file)) return
  fs.writeFileSync(file, content, 'utf8')
}

/** 把模板的 `nide.profile.bundles` 合并进既有 profile（只在本地为空时） */
function mergeProfileBundles(template: Record<string, unknown>, profileDir: string): void {
  const read = (dir: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >
    } catch {
      return null
    }
  }

  const bundlesOf = (manifest: Record<string, unknown> | null): string[] => {
    const nide = manifest?.nide as { profile?: { bundles?: unknown } } | undefined
    const bundles = nide?.profile?.bundles
    return Array.isArray(bundles)
      ? bundles.filter((entry): entry is string => typeof entry === 'string')
      : []
  }

  const templateBundles = bundlesOf(template)
  if (templateBundles.length === 0) return

  const local = read(profileDir)
  if (!local || bundlesOf(local).length > 0) return

  const nide = (local.nide ?? {}) as Record<string, unknown>
  const profile = (nide.profile ?? {}) as Record<string, unknown>
  local.nide = { ...nide, profile: { ...profile, bundles: templateBundles } }
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify(local, null, 2)}\n`,
    'utf8'
  )
}

/**
 * 读取 cordis.yml，替换占位符，并做最小结构校验。
 *
 * `nideRoot` 是 `{{NIDE_ROOT}}` 的展开值：源码树里是仓库根，打包版是编译产物根
 * （`out/host`，那里有一份改写过的 profile 模板，插件路径指向 `.js`）。
 */
export interface LoadRowsOptions {
  /**
   * 跑的是**编译产物**（`out/host`）还是源码树。
   *
   * profile 里统一写源码路径（`.../src/index.ts`）：编译产物里同名文件是 `.js`，
   * 这里按布局改写。这样**一份 profile 在 dev 与打包版通用**。以前是构建脚本改写
   * 产物里的 profile，于是「dev 写的 profile 拿去跑打包版」会指向不存在的 `.ts`
   * （真实踩过：ERR_MODULE_NOT_FOUND …/services/project/src/index.ts）。
   */
  compiled?: boolean
}

export function loadRows(
  paths: NidePaths,
  nideRoot: string = REPO_ROOT,
  options: LoadRowsOptions = {}
): ProfileRow[] {
  const layers = composeLayers(paths, nideRoot)
  const rows = applyPatches(layers, (warning) => {
    console.warn(`[nide-boot] ${warning.layer}: ${warning.message}`)
  })

  return normalizeRows(rows, options)
}

/** 一层的名字与内容；`cordis.yml` 也算一层（兼容老 profile） */
function composeLayers(
  paths: NidePaths,
  nideRoot: string
): { name: string; operations: PatchOperation[] }[] {
  const layers: { name: string; operations: PatchOperation[] }[] = []

  for (const bundle of readBundles(paths)) {
    const file = bundlePatchFile(bundle, paths, nideRoot)
    layers.push({ name: bundle, operations: readPatchFile(file, nideRoot) })
  }

  const cordis = path.join(paths.profileDir, 'cordis.yml')
  layers.push({ name: 'cordis.yml', operations: readPatchFile(cordis, nideRoot) })

  const patch = path.join(paths.profileDir, 'cordis.patch.yml')
  if (fs.existsSync(patch)) {
    layers.push({ name: 'cordis.patch.yml', operations: readPatchFile(patch, nideRoot) })
  }

  return layers
}

function readPatchFile(file: string, nideRoot: string): PatchOperation[] {
  const text = fs.readFileSync(file, 'utf8')
  const expanded = text.replaceAll('{{NIDE_ROOT}}', nideRoot.replaceAll('\\', '/'))
  return toPatchOperations(yaml.load(expanded), file)
}

/** profile/package.json 的 `nide.profile.bundles`（顺序即应用顺序） */
function readBundles(paths: NidePaths): string[] {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(paths.profileDir, 'package.json'), 'utf8')
    ) as { nide?: { profile?: { bundles?: unknown } } }
    const bundles = raw.nide?.profile?.bundles
    if (!Array.isArray(bundles)) return []
    return bundles.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  } catch {
    return []
  }
}

/**
 * 一个 bundle 的 patch 文件。
 *
 * 支持三种写法：`{{NIDE_ROOT}}/...`（仓库内组合包，dev 与打包版通用）、
 * 绝对路径、以及包名（从 profile 或仓库的 node_modules 解析）。
 */
function bundlePatchFile(bundle: string, paths: NidePaths, nideRoot: string): string {
  const expanded = bundle.replaceAll('{{NIDE_ROOT}}', nideRoot.replaceAll('\\', '/'))
  if (path.isAbsolute(expanded) || expanded.startsWith('.')) {
    return path.join(expanded, 'cordis.patch.yml')
  }

  for (const base of [paths.profileDir, nideRoot]) {
    const candidate = path.join(base, 'node_modules', expanded, 'cordis.patch.yml')
    if (fs.existsSync(candidate)) return candidate
  }

  throw new Error(`bundle "${bundle}" not found (looked in profile and ${nideRoot})`)
}

/** 逐行校验 + 编译产物改写；group 的嵌套行也要递归处理 */
function normalizeRows(rows: readonly PatchRow[], options: LoadRowsOptions): ProfileRow[] {
  return rows.map((row) => normalizeRow(row, options))
}

function normalizeRow(row: PatchRow, options: LoadRowsOptions): ProfileRow {
  if (!row || typeof row !== 'object') throw new Error('profile row must be an object')
  if (typeof row.id !== 'string' || row.id.length === 0) {
    throw new Error('profile row is missing "id"')
  }
  if (row.group === true) {
    if (!Array.isArray(row.config)) {
      throw new Error(`group row "${row.id}" needs an array "config"`)
    }
  } else if (typeof row.name !== 'string' || row.name.length === 0) {
    throw new Error(`profile row "${row.id}" is missing "name"`)
  }

  return {
    id: row.id,
    name:
      typeof row.name === 'string' && options.compiled ? compiledEntry(row.name) : (row.name ?? ''),
    ...(row.core === true ? { core: true as const } : {}),
    ...(typeof row.description === 'string' && row.description.length > 0
      ? { description: row.description }
      : {}),
    ...(row.group === true ? { group: true as const } : {}),
    ...(row.config === undefined
      ? {}
      : {
          config:
            row.group === true && Array.isArray(row.config)
              ? normalizeRows(row.config as PatchRow[], options)
              : row.config
        }),
    ...(row.disabled === true ? { disabled: true } : {})
  }
}

/** 把 profile 里的路径/URL 变成 loader 能 import 的 specifier。 */
export function toImportSpecifier(name: string): string {
  if (name.startsWith('file:') || name.startsWith('node:') || name.startsWith('cordis:')) {
    return name
  }
  if (path.isAbsolute(name)) return pathToFileURL(name).href
  // 包标识符原样交给 Node 解析；MVP 阶段它必须能在仓库 node_modules 里找到。
  return name
}

/**
 * 源码入口 -> 编译产物入口：`.../src/index.ts` -> `.../src/index.js`。
 *
 * 只认这一种形状（profile 里的行都指向包入口），别的形状原样返回 —— 猜错比不改写更糟。
 */
function compiledEntry(name: string): string {
  return name.endsWith('/src/index.ts') ? name.replace(/\/src\/index\.ts$/, '/src/index.js') : name
}

export function dumpRows(rows: ProfileRow[]): string {
  const lines = [
    '# composed profile rows（bundle → cordis.yml → cordis.patch.yml）',
    ...rows.flatMap((row) => [
      `- id: ${row.id}`,
      `  name: ${row.name}`,
      ...(row.core ? ['  core: true'] : []),
      ...(row.group ? ['  group: true'] : []),
      ...(row.description ? [`  description: ${row.description}`] : []),
      ...(row.disabled ? ['  disabled: true'] : [])
    ])
  ]
  return lines.join('\n')
}

export interface BootedHost {
  ctx: Context
  entryIds: string[]
}

export interface BootOptions {
  nideRoot?: string
  compiled?: boolean
  /** 已经组合好的行（宿主侧算 `hostEnv.profileRows` 时也要用同一份） */
  rows?: ProfileRow[]
  /** `rpc` 与 `hostEnv`：作为 `nide:host` 插件先挂上，其余条目靠 inject 取 */
  host: InstallOptions
}

export async function boot(paths: NidePaths, options: BootOptions): Promise<BootedHost> {
  const rows =
    options.rows ?? loadRows(paths, options.nideRoot ?? REPO_ROOT, { compiled: options.compiled })
  const ctx = new Context()

  // TODO: 换成 electron-log / 文件 exporter；MVP 先证明 Cordis 日志能出来。
  ctx.logger.exporter({
    export(message) {
      const text = message.args
        .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
        .join(' ')
      console.log(`[${message.name}] ${text}`)
    }
  })

  // 与 Cordis 自带 `env` 区分：宿主环境叫 `hostEnv`，在插件树里是普通服务
  await ctx.plugin(hostServices(options.host))

  // baseUrl 决定相对 specifier / 相对配置路径的解析基准（与 DSH 一致）。
  const baseUrl = pathToFileURL(path.join(paths.profileDir, 'index.js')).href
  await ctx.plugin(Loader, { baseUrl })

  const entryIds: string[] = []
  for (const row of rows) {
    if (row.disabled) continue
    /**
     * **所有**行都交给 loader —— 服务与插件没有区别。
     *
     * 注意 loader 的 `create()` 不接受 id（它自己生成）：稳定 id 只在阶段 B 把
     * patch 合并结果交给 include 插件时才会回到 loader 里。这里的 `row.id` 仍用于
     * 我们自己的日志、`core` 列表与 patch 合并。
     */
    const entryId = await ctx.loader.create({
      name: toImportSpecifier(row.name),
      ...(row.group === true ? { group: true } : {}),
      ...(row.config === undefined ? {} : { config: row.config })
    })
    entryIds.push(entryId)
  }

  // 等所有条目的 import / 激活完成；optional 条目的失败由 loader 记录。
  await ctx.loader.await()
  await awaitEntries(ctx, entryIds)

  return { ctx, entryIds }
}

/** profile 条目全部激活的等待上限（`inject` 依赖缺失时不要静默挂着） */
const ENTRY_READY_TIMEOUT_MS = 15_000

/**
 * 等每个条目真的进入 ACTIVE（或 FAILED）。
 *
 * `loader.await()` 只等 import / 创建任务；`inject` 触发的激活是另一轮微任务，
 * 所以服务可能还没 apply 就把控制权交回宿主 —— 宿主下一行就 `ctx.ai`，拿到
 * undefined。这里改成逐个 await 条目的 fiber：Cordis 的 Fiber 是 thenable，
 * ACTIVE 才 resolve。
 *
 * 依赖缺失会让 fiber 永远 PENDING，所以必须带超时：宁可启动失败并列出卡住的
 * 条目，也不要让宿主进程「看起来起来了」。
 */
async function awaitEntries(ctx: Context, ids: string[]): Promise<void> {
  const pending = new Set(ids)
  let timer: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`profile entries did not activate: ${[...pending].join(', ')}`))
    }, ENTRY_READY_TIMEOUT_MS)
    timer.unref?.()
  })

  const waiters = ids.map(async (id) => {
    const entry = ctx.loader.resolve(id)
    if (entry.fiber) await entry.fiber
    pending.delete(id)
  })

  try {
    await Promise.race([Promise.all(waiters), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function shutdown(host: BootedHost): Promise<void> {
  for (const entryId of [...host.entryIds].reverse()) {
    host.ctx.loader.remove(entryId)
  }
  await host.ctx.loader.await()
}
