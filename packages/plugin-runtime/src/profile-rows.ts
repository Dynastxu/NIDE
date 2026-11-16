import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/**
 * 安装式插件在 profile patch 里的那一行。
 *
 * DSH 对齐的核心：**安装 = 包 + 一行**。行写进 `<profile>/cordis.patch.yml`，
 * 指向 `plugin-shim`（`config.dir` 是插件目录）；插件服务不再靠扫描目录发现它们。
 *
 * 写文件时保留其它行（用户手写的 patch 也是资产），只增删 `plugin:` 前缀的行。
 */

export const PROFILE_PATCH_FILE = 'cordis.patch.yml'
export const PLUGIN_ROW_PREFIX = 'plugin:'
export const PLUGIN_SHIM_SPECIFIER = '{{NIDE_ROOT}}/packages/host/src/plugin-shim.ts'

const HEADER = [
  '# 用户覆盖层（schema 与 DSH 一致：顶层是 patch 数组）。',
  '# 安装 / 卸载插件会在这里增删 id 以 "plugin:" 开头的行，其余行原样保留。',
  ''
].join('\n')

export function pluginRowId(pluginId: string): string {
  return `${PLUGIN_ROW_PREFIX}${pluginId}`
}

export function patchPath(profileDir: string): string {
  return path.join(profileDir, PROFILE_PATCH_FILE)
}

/**
 * 读 patch：文件不存在 / 空文件 / 空数组都算「没有操作」。
 *
 * patch 方言里一项可以是 `{ insert }` 或按 id 覆盖；这里只做无损搬运，不解释语义。
 */
export function readPatch(profileDir: string): unknown[] {
  const file = patchPath(profileDir)
  try {
    const parsed = yaml.load(fs.readFileSync(file, 'utf8')) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writePatch(profileDir: string, operations: unknown[]): void {
  const file = patchPath(profileDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${HEADER}${yaml.dump(operations, { lineWidth: -1 })}`, 'utf8')
}

/** 从所有 insert 操作里摘掉某个 id（upsert 的第一步） */
function withoutRow(operations: unknown[], id: string): unknown[] {
  const result: unknown[] = []

  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
      result.push(operation)
      continue
    }
    const record = operation as Record<string, unknown>
    if (!Array.isArray(record.insert)) {
      result.push(operation)
      continue
    }

    const rows = (record.insert as unknown[]).filter(
      (row) => !(row && typeof row === 'object' && (row as { id?: unknown }).id === id)
    )
    // 整条 insert 被删空时丢掉这个操作，别留下 `{ insert: [] }`
    if (rows.length > 0) result.push({ ...record, insert: rows })
  }

  return result
}

/**
 * 写入 / 更新一个插件行。
 *
 * @param profileDir - profile 根
 * @param pluginId - manifest 里的插件 id（行 id 会加 `plugin:` 前缀）
 * @param dir - 插件目录（绝对路径；运行时就是 `<userData>/plugins/<dir>`）
 */
export function upsertPluginRow(profileDir: string, pluginId: string, dir: string): string {
  const id = pluginRowId(pluginId)
  const operations = withoutRow(readPatch(profileDir), id)
  operations.push({
    insert: [
      {
        id,
        name: PLUGIN_SHIM_SPECIFIER,
        config: { dir }
      }
    ]
  })
  writePatch(profileDir, operations)
  return id
}

/** 删掉一个插件行；返回它是否原本存在 */
export function removePluginRow(profileDir: string, pluginId: string): boolean {
  const id = pluginRowId(pluginId)
  const operations = readPatch(profileDir)
  const next = withoutRow(operations, id)
  if (next.length === operations.length && JSON.stringify(next) === JSON.stringify(operations)) {
    return false
  }
  writePatch(profileDir, next)
  return true
}

/** 找出某插件目录在 patch 里的行（重装 / 卸载时定位） */
export function findPluginRow(
  profileDir: string,
  pluginId: string
): { id: string; dir: string } | null {
  const id = pluginRowId(pluginId)
  for (const operation of readPatch(profileDir)) {
    if (!operation || typeof operation !== 'object') continue
    const rows = (operation as { insert?: unknown }).insert
    if (!Array.isArray(rows)) continue
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const record = row as { id?: unknown; config?: { dir?: unknown } }
      if (record.id === id && typeof record.config?.dir === 'string') {
        return { id, dir: record.config.dir }
      }
    }
  }
  return null
}
