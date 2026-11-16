/**
 * Loader **patch 方言**（与 DSH 的 `cordis.patch.yml` 一致）。
 *
 * 组合不是「很多份完整配置」，而是「一张行表 + 按 id 改它」：
 * - `insert: [rows]` 追加行；带 `id` 时插进那个 `group: true` 行的 `config` 里；
 * - 只带 `id` 的操作按 id 改已有行，**`config` 整体替换**（不是深合并）；
 * - 匹配不到 id、或者既没有 `insert` 也没有非空 `id` 的操作 → 告警并跳过。
 *
 * 顺序：bundle 层（按 `nide.profile.bundles` 顺序）→ profile 的 `cordis.yml`
 * （当作一次 insert，兼容老文件）→ profile 的 `cordis.patch.yml` → 将来的 overlay。
 * 后写的赢。
 */

export interface PatchRow {
  id: string
  name: string
  config?: unknown
  disabled?: boolean
  /** 核心行（宿主服务 / 平台层）：设置页单独展示，且不可启停 */
  core?: boolean
  description?: string
  /** 这一行的 `config` 是一张嵌套行表，patch 可以按 id 往里 insert */
  group?: boolean
}

/** 一层 patch 的一个操作 */
export interface PatchOperation {
  insert?: PatchRow[]
  id?: string
  name?: string
  config?: unknown
  disabled?: boolean
  core?: boolean
  description?: string
}

export interface PatchWarning {
  layer: string
  message: string
}

/**
 * 把多层操作合成为最终行表。
 *
 * @param layers - 每层的操作列表，按应用顺序
 * @param warn - 收集告警（匹配不到、重复 id、无效操作）
 */
export function applyPatches(
  layers: readonly { name: string; operations: readonly PatchOperation[] }[],
  warn: (warning: PatchWarning) => void = () => {}
): PatchRow[] {
  const order: string[] = []
  const rows = new Map<string, PatchRow>()

  for (const layer of layers) {
    for (const operation of layer.operations) {
      if (operation.insert !== undefined) {
        insertRows(layer.name, operation, order, rows, warn)
        continue
      }

      const id = typeof operation.id === 'string' ? operation.id.trim() : ''
      if (!id) {
        warn({ layer: layer.name, message: 'operation has neither "insert" nor an "id", skipped' })
        continue
      }

      const existing = rows.get(id)
      if (!existing) {
        warn({ layer: layer.name, message: `no row with id "${id}", skipped` })
        continue
      }

      if (typeof operation.name === 'string' && operation.name !== existing.name) {
        warn({
          layer: layer.name,
          message: `row "${id}" is "${existing.name}", patch asserts "${operation.name}"`
        })
      }
      if (operation.config !== undefined) existing.config = operation.config
      if (operation.disabled !== undefined) existing.disabled = operation.disabled
      if (operation.core !== undefined) existing.core = operation.core
      if (operation.description !== undefined) existing.description = operation.description
    }
  }

  return order.map((id) => rows.get(id)!)
}

function insertRows(
  layer: string,
  operation: PatchOperation,
  order: string[],
  rows: Map<string, PatchRow>,
  warn: (warning: PatchWarning) => void
): void {
  const target = operation.id?.trim()
  if (target) {
    const parent = rows.get(target)
    if (!parent || parent.group !== true) {
      warn({
        layer,
        message: `insert targets "${target}", which is not an existing group row, skipped`
      })
      return
    }
    const children = Array.isArray(parent.config) ? (parent.config as PatchRow[]) : []
    parent.config = children
    for (const row of operation.insert ?? []) {
      if (!row.id || rows.has(row.id)) {
        warn({ layer, message: `duplicate row id "${row.id}", skipped` })
        continue
      }
      children.push(row)
      rows.set(row.id, row)
    }
    return
  }

  for (const row of operation.insert ?? []) {
    if (!row.id || !row.name) {
      warn({ layer, message: 'inserted row needs both "id" and "name", skipped' })
      continue
    }
    if (rows.has(row.id)) {
      warn({ layer, message: `duplicate row id "${row.id}", skipped` })
      continue
    }
    order.push(row.id)
    rows.set(row.id, row)
  }
}

/**
 * 把一份 YAML（`cordis.yml` / `cordis.patch.yml`）解成操作列表。
 *
 * 兼容老 profile：数组里直接写「行」而不是 `insert` 操作时，视作一次 insert。
 */
export function toPatchOperations(raw: unknown, file: string): PatchOperation[] {
  if (!Array.isArray(raw)) throw new Error(`${file} must contain a YAML array`)

  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${file}: item #${index} must be an object`)
    }
    const record = item as Record<string, unknown>
    if (Array.isArray(record.insert)) {
      return { ...record, insert: record.insert as PatchRow[] } as PatchOperation
    }
    if (typeof record.name === 'string' && record.name.length > 0) {
      // 老形状：一行就是一个插件条目
      return { insert: [record as unknown as PatchRow] }
    }
    return record as PatchOperation
  })
}
