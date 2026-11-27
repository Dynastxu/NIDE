import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  findPluginRow,
  pluginRowId,
  readPatch,
  removePluginRow,
  upsertPluginRow
} from '@nide/service-plugins/profile-rows.ts'

/**
 * 安装 = 包 + 一行。这些用例钉住「写 patch 时不破坏用户自己的行」这条约束，
 * 以及 upsert / remove 的幂等性。
 */
let profileDir = ''

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nide-profile-rows-'))
})

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true })
})

describe('profile patch：插件行', () => {
  it('写入一行 plugin:<id>，指向 shim 并带上目录', () => {
    const id = upsertPluginRow(profileDir, 'user.demo', 'C:/plugins/demo')

    expect(id).toBe('plugin:user.demo')
    const operations = readPatch(profileDir) as {
      insert: { id: string; name: string; config: { dir: string } }[]
    }[]
    expect(operations).toHaveLength(1)
    expect(operations[0]?.insert[0]).toMatchObject({
      id: 'plugin:user.demo',
      name: '{{NIDE_ROOT}}/packages/host/src/plugin-shim.ts',
      config: { dir: 'C:/plugins/demo' }
    })
  })

  it('重复安装（升级）是 upsert：行不重复，目录更新', () => {
    upsertPluginRow(profileDir, 'user.demo', 'C:/plugins/demo')
    upsertPluginRow(profileDir, 'user.demo', 'C:/plugins/demo-2')

    const rows = (readPatch(profileDir) as { insert: unknown[] }[]).flatMap(
      (operation) => operation.insert
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: 'plugin:user.demo', config: { dir: 'C:/plugins/demo-2' } })
  })

  it('不破坏用户自己的行（只增删 plugin: 行）', () => {
    fs.writeFileSync(
      path.join(profileDir, 'cordis.patch.yml'),
      yaml.dump([{ insert: [{ id: 'my-row', name: './my.ts' }] }]) + '\n'
    )

    upsertPluginRow(profileDir, 'user.demo', 'C:/plugins/demo')
    removePluginRow(profileDir, 'user.demo')

    const operations = readPatch(profileDir) as { insert: { id: string }[] }[]
    expect(operations.flatMap((operation) => operation.insert).map((row) => row.id)).toEqual([
      'my-row'
    ])
  })

  it('删除不存在的行返回 false，文件保持可用', () => {
    expect(removePluginRow(profileDir, 'user.none')).toBe(false)
    expect(readPatch(profileDir)).toEqual([])
  })

  it('findPluginRow 按插件 id 找目录（重装 / 卸载定位用）', () => {
    upsertPluginRow(profileDir, 'user.demo', 'C:/plugins/demo')
    expect(findPluginRow(profileDir, 'user.demo')).toEqual({
      id: pluginRowId('user.demo'),
      dir: 'C:/plugins/demo'
    })
    expect(findPluginRow(profileDir, 'user.none')).toBeNull()
  })
})
