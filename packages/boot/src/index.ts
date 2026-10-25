import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import yaml from 'js-yaml'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'

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
 */
export function ensureProfile(paths: NidePaths, reset = false): void {
  const template = path.join(REPO_ROOT, 'profiles', paths.profileName)
  if (!fs.existsSync(template)) {
    throw new Error(`profile template not found: ${template}`)
  }

  if (reset && fs.existsSync(paths.profileDir)) {
    fs.rmSync(paths.profileDir, { recursive: true, force: true })
  }

  fs.mkdirSync(paths.profileDir, { recursive: true })
  for (const file of fs.readdirSync(template)) {
    const source = path.join(template, file)
    const target = path.join(paths.profileDir, file)
    if (fs.existsSync(target)) continue
    fs.cpSync(source, target, { recursive: true })
  }
  fs.mkdirSync(path.join(paths.profileDir, 'node_modules'), { recursive: true })

  // TODO: 读取 package.json 的 nide.profile.bundles 并合成 bundle patch 层
}

/** 读取 cordis.yml，替换开发期占位符，并做最小结构校验。 */
export function loadRows(paths: NidePaths): ProfileRow[] {
  const file = path.join(paths.profileDir, 'cordis.yml')
  const text = fs.readFileSync(file, 'utf8')
  const expanded = text.replaceAll('{{NIDE_ROOT}}', REPO_ROOT.replaceAll('\\', '/'))
  const parsed = yaml.load(expanded)

  if (!Array.isArray(parsed)) {
    throw new Error(`${file} must contain a YAML array`)
  }

  return parsed.map((raw, index) => normalizeRow(raw, index, file))
}

function normalizeRow(raw: unknown, index: number, file: string): ProfileRow {
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
  return {
    id: row.id,
    name: row.name,
    ...(row.config === undefined ? {} : { config: row.config }),
    ...(row.disabled === true ? { disabled: true } : {})
  }
}

/** 把 profile 里的路径/URL 变成 loader 能 import 的 specifier。 */
function toImportSpecifier(name: string): string {
  if (name.startsWith('file:') || name.startsWith('node:') || name.startsWith('cordis:')) {
    return name
  }
  if (path.isAbsolute(name)) return pathToFileURL(name).href
  // 包标识符原样交给 Node 解析；MVP 阶段它必须能在仓库 node_modules 里找到。
  return name
}

export function dumpRows(rows: ProfileRow[]): string {
  const lines = [
    '# composed profile rows（MVP：bundle / patch 层尚未实现）',
    ...rows.flatMap((row) => [
      `- id: ${row.id}`,
      `  name: ${row.name}`,
      ...(row.disabled ? ['  disabled: true'] : [])
    ])
  ]
  return lines.join('\n')
}

export interface BootedHost {
  ctx: Context
  entryIds: string[]
}

export async function boot(paths: NidePaths): Promise<BootedHost> {
  const rows = loadRows(paths)
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

  // baseUrl 决定相对 specifier / 相对配置路径的解析基准（与 DSH 一致）。
  const baseUrl = pathToFileURL(path.join(paths.profileDir, 'index.js')).href
  await ctx.plugin(Loader, { baseUrl })

  const entryIds: string[] = []
  for (const row of rows) {
    if (row.disabled) continue
    const entryId = await ctx.loader.create({
      name: toImportSpecifier(row.name),
      ...(row.config === undefined ? {} : { config: row.config })
    })
    entryIds.push(entryId)
  }

  // 等所有条目的 import / 激活完成；optional 条目的失败由 loader 记录。
  await ctx.loader.await()

  return { ctx, entryIds }
}

export async function shutdown(host: BootedHost): Promise<void> {
  for (const entryId of [...host.entryIds].reverse()) {
    host.ctx.loader.remove(entryId)
  }
  await host.ctx.loader.await()
}
