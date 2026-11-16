import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { hostServices, type InstallOptions } from '../../kernel/src/context.ts'

/**
 * NIDE profile 启动层（MVP）。
 *
 * 现阶段的职责刻意收得很窄：
 * 1. 找到 / 初始化 NIDE_HOME 下的 profile；
 * 2. 读一份 cordis.yml（还没有 bundle 与 patch 层）；
 * 3. 用 DSH 的 loader 逐行导入插件。
 *
 * TODO（按 docs/architecture/cordis-migration.md 阶段 1 之后补）：
 * - bundle 组合包：nide.profile.bundles → 各自的 patch 文件
 * - profile / home 的 cordis.patch.yml 覆盖
 * - `!!js` 表达式、disabled 求值、required 启动审计
 * - runtime resolution：从 profile/node_modules 解析包标识符
 * - 模块热替换与重载
 */

export interface ProfileRow {
  id: string
  name: string
  /**
   * 核心行：宿主服务 / 平台层。
   *
   * 设置页的「核心包」列表用它，而且这些行不可启停（禁掉内核等于关掉应用）。
   * 与 DSH 的差别：DSH 没有这个标记，靠组合层判断；NIDE 的插件页需要静态展示它。
   */
  core?: boolean
  /** 面向开发者的说明（设置里的「核心包」列表展示用） */
  description?: string
  config?: unknown
  disabled?: boolean
}

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
 * 首次启动时从仓库模板复制一份 profile。
 *
 * 只补缺失的文件，不覆盖已有的 cordis.yml / patch —— 用户手改过的配置不能被启动流程盖掉。
 * 需要重新初始化时传 reset=true（目前只给开发脚本用）。
 *
 * `templateRoot` 是**模板所在的 profiles 目录**。默认用源码树里的 `profiles/`；
 * 打包版由 host 显式传入编译产物里的 `profiles/`（`REPO_ROOT` 是按模块位置算的，
 * 编译之后指不到源码树）。
 */
export function ensureProfile(paths: NidePaths, reset = false, templateRoot?: string): void {
  const root = templateRoot ?? path.join(REPO_ROOT, 'profiles')
  const template = path.join(root, paths.profileName)
  if (!fs.existsSync(template)) {
    throw new Error(`profile template not found: ${template}`)
  }

  if (reset && fs.existsSync(paths.profileDir)) {
    fs.rmSync(paths.profileDir, { recursive: true, force: true })
  }

  fs.mkdirSync(paths.profileDir, { recursive: true })

  /**
   * 模板升级：`cordis.yml` 是**装配点**，宿主靠它决定装哪些服务 —— 老用户机器上
   * 那份是旧的（只补缺失文件的策略不会更新它），于是服务会缺。
   *
   * 规则：模板版本比本地新时，覆盖 `cordis.yml`（旧的留成 `cordis.yml.bak`）。
   * 只动这一个文件：`cordis.patch.yml` 与 `package.json` 是用户的地盘。
   */
  const templateVersion = readProfileVersion(template)
  const localVersion = readProfileVersion(paths.profileDir)
  const upgrading = templateVersion > localVersion

  for (const file of fs.readdirSync(template)) {
    const source = path.join(template, file)
    const target = path.join(paths.profileDir, file)

    if (file === 'cordis.yml' && upgrading && fs.existsSync(target)) {
      fs.cpSync(target, `${target}.bak`, { force: true })
      fs.cpSync(source, target, { force: true })
      continue
    }

    if (fs.existsSync(target)) continue
    fs.cpSync(source, target, { recursive: true })
  }

  if (upgrading) writeProfileVersion(paths.profileDir, templateVersion)
  fs.mkdirSync(path.join(paths.profileDir, 'node_modules'), { recursive: true })

  // TODO: 读取 package.json 的 nide.profile.bundles 并合成 bundle patch 层
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
  const file = path.join(paths.profileDir, 'cordis.yml')
  const text = fs.readFileSync(file, 'utf8')
  const expanded = text.replaceAll('{{NIDE_ROOT}}', nideRoot.replaceAll('\\', '/'))
  const parsed = yaml.load(expanded)

  if (!Array.isArray(parsed)) {
    throw new Error(`${file} must contain a YAML array`)
  }

  return parsed.map((raw, index) => normalizeRow(raw, index, file, options))
}

function normalizeRow(
  raw: unknown,
  index: number,
  file: string,
  options: LoadRowsOptions
): ProfileRow {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file}: row #${index} must be an object`)
  }
  const row = raw as Record<string, unknown>
  if (typeof row.name !== 'string' || row.name.length === 0) {
    throw new Error(`${file}: row #${index} is missing "name"`)
  }
  if (typeof row.id !== 'string' || row.id.length === 0) {
    throw new Error(`${file}: row #${index} is missing "id"`)
  }
  if (row.core !== undefined && typeof row.core !== 'boolean') {
    throw new Error(`${file}: row #${index} has a non-boolean "core"`)
  }

  return {
    id: row.id,
    name: options.compiled ? compiledEntry(row.name) : row.name,
    ...(row.core === true ? { core: true as const } : {}),
    ...(typeof row.description === 'string' && row.description.length > 0
      ? { description: row.description }
      : {}),
    ...(row.config === undefined ? {} : { config: row.config }),
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
    '# composed profile rows（MVP：bundle / patch 层尚未实现）',
    ...rows.flatMap((row) => [
      `- id: ${row.id}`,
      `  name: ${row.name}`,
      ...(row.core ? ['  core: true'] : []),
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
  const rows = options.rows ?? loadRows(paths, options.nideRoot ?? REPO_ROOT, { compiled: options.compiled })
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
