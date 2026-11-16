import { describe, expect, it } from 'vitest'
import {
  applyPatches,
  toPatchOperations,
  type PatchOperation,
  type PatchWarning
} from '../../packages/boot/src/patch.ts'

/**
 * patch 方言（与 DSH 的 cordis.patch.yml 一致）。
 *
 * 三个决定性语义：
 * - `insert` 追加，按 id 找到 `group: true` 的行时插进它的 config；
 * - 只带 id 的操作覆盖已有行的字段，`config` **整体替换**（不是深合并）；
 * - 匹配不到 / 无效操作只告警并跳过，不中断启动。
 */
function run(...layers: { name: string; operations: PatchOperation[] }[]): {
  rows: ReturnType<typeof applyPatches>
  warnings: PatchWarning[]
} {
  const warnings: PatchWarning[] = []
  const rows = applyPatches(layers, (warning) => warnings.push(warning))
  return { rows, warnings }
}

describe('patch：insert', () => {
  it('按层顺序追加，id 与顺序都保留', () => {
    const { rows, warnings } = run(
      { name: 'base', operations: [{ insert: [{ id: 'a', name: './a.ts' }] }] },
      { name: 'web', operations: [{ insert: [{ id: 'b', name: './b.ts' }] }] }
    )

    expect(rows.map((row) => row.id)).toEqual(['a', 'b'])
    expect(warnings).toEqual([])
  })

  it('重复 id 只告警并跳过（后层不能悄悄把行换掉）', () => {
    const { rows, warnings } = run(
      { name: 'base', operations: [{ insert: [{ id: 'a', name: './a.ts' }] }] },
      { name: 'web', operations: [{ insert: [{ id: 'a', name: './other.ts' }] }] }
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('./a.ts')
    expect(warnings[0]?.message).toMatch(/duplicate/)
  })

  it('insert 指向 group 行时插进它的 config', () => {
    const { rows } = run({
      name: 'base',
      operations: [
        { insert: [{ id: 'win', name: 'cordis:group', group: true, config: [] }] },
        { insert: [{ id: 'view', name: './view.ts' }], id: 'win' }
      ]
    })

    expect(rows).toHaveLength(1)
    expect((rows[0]?.config as { id: string }[]).map((row) => row.id)).toEqual(['view'])
  })

  it('insert 指向不存在的 group 只告警', () => {
    const { rows, warnings } = run({
      name: 'web',
      operations: [{ insert: [{ id: 'x', name: './x.ts' }], id: 'missing' }]
    })
    expect(rows).toEqual([])
    expect(warnings[0]?.message).toMatch(/not an existing group/)
  })
})

describe('patch：按 id 覆盖', () => {
  it('config 整体替换，不是深合并', () => {
    const { rows } = run(
      {
        name: 'base',
        operations: [
          { insert: [{ id: 'llm', name: './llm.ts', config: { model: 'a', temperature: 0.7 } }] }
        ]
      },
      { name: 'web', operations: [{ id: 'llm', config: { model: 'b' } }] }
    )

    // 少写的 temperature 不是「保留」，而是消失（插件回默认值）
    expect(rows[0]?.config).toEqual({ model: 'b' })
  })

  it('disabled / core / description 逐字段覆盖', () => {
    const { rows } = run(
      {
        name: 'base',
        operations: [{ insert: [{ id: 'a', name: './a.ts', core: true }] }]
      },
      { name: 'user', operations: [{ id: 'a', disabled: true, core: false, description: 'off' }] }
    )

    expect(rows[0]).toMatchObject({ disabled: true, core: false, description: 'off' })
  })

  it('匹配不到 id 只告警并跳过', () => {
    const { rows, warnings } = run({
      name: 'user',
      operations: [{ id: 'nope', disabled: true }]
    })
    expect(rows).toEqual([])
    expect(warnings[0]?.message).toMatch(/no row with id/)
  })

  it('name 是断言而不是改名：不一致要告警', () => {
    const { rows, warnings } = run(
      { name: 'base', operations: [{ insert: [{ id: 'a', name: './a.ts' }] }] },
      { name: 'web', operations: [{ id: 'a', name: './b.ts' }] }
    )

    expect(rows[0]?.name).toBe('./a.ts')
    expect(warnings[0]?.message).toMatch(/asserts/)
  })

  it('既没有 insert 也没有 id 的操作只告警', () => {
    const { rows, warnings } = run({ name: 'bad', operations: [{ config: {} }] })
    expect(rows).toEqual([])
    expect(warnings[0]?.message).toMatch(/neither/)
  })
})

describe('patch：文件解析', () => {
  it('老形状（数组里直接是行）视作一次 insert', () => {
    const operations = toPatchOperations(
      [{ id: 'hello', name: './hello.ts', config: { greeting: 'hi' } }],
      'cordis.yml'
    )

    expect(operations).toEqual([
      { insert: [{ id: 'hello', name: './hello.ts', config: { greeting: 'hi' } }] }
    ])
  })

  it('非数组直接报错（配置文件写错不能让启动静默降级）', () => {
    expect(() => toPatchOperations({}, 'cordis.yml')).toThrow(/YAML array/)
  })
})
