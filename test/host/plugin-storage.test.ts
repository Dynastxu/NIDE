import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginStorage, pluginStorageFile } from '../../packages/services/plugins/src/storage.ts'

let base = ''

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'nide-storage-'))
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

function readFile(pluginId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(pluginStorageFile(base, pluginId), 'utf-8')) as Record<
    string,
    unknown
  >
}

describe('PluginStorage', () => {
  it('set / get / keys / delete 是同步视图', () => {
    const storage = new PluginStorage({ userDataDir: base })

    storage.set('demo.one', 'count', 1)
    storage.set('demo.one', 'name', 'notes')

    expect(storage.get('demo.one', 'count')).toBe(1)
    expect(storage.snapshot('demo.one')).toEqual({ count: 1, name: 'notes' })
    expect(storage.snapshot('demo.one')).not.toBe(storage.snapshot('demo.one'))

    storage.delete('demo.one', 'count')
    expect(storage.get('demo.one', 'count')).toBeUndefined()
    expect(storage.snapshot('demo.one')).toEqual({ name: 'notes' })
  })

  it('flush 落盘，新实例读得回来', () => {
    const first = new PluginStorage({ userDataDir: base })
    first.set('demo.one', 'items', ['a', 'b'])
    first.flush('demo.one')

    expect(readFile('demo.one')).toEqual({ items: ['a', 'b'] })

    const second = new PluginStorage({ userDataDir: base })
    expect(second.snapshot('demo.one')).toEqual({ items: ['a', 'b'] })
  })

  it('没有变化时 flush 不写盘（不会重写文件）', () => {
    const storage = new PluginStorage({ userDataDir: base })
    storage.flush('demo.one')
    expect(fs.existsSync(pluginStorageFile(base, 'demo.one'))).toBe(false)
  })

  it('插件之间命名空间隔离', () => {
    const storage = new PluginStorage({ userDataDir: base })
    storage.set('demo.one', 'key', 'one')
    storage.set('demo.two', 'key', 'two')

    expect(storage.get('demo.one', 'key')).toBe('one')
    expect(storage.get('demo.two', 'key')).toBe('two')
  })

  it('remove 删掉内存与文件', () => {
    const storage = new PluginStorage({ userDataDir: base })
    storage.set('demo.one', 'key', true)
    storage.flush('demo.one')
    expect(fs.existsSync(pluginStorageFile(base, 'demo.one'))).toBe(true)

    storage.remove('demo.one')
    expect(fs.existsSync(pluginStorageFile(base, 'demo.one'))).toBe(false)
    expect(storage.snapshot('demo.one')).toEqual({})
  })

  it('坏文件当作空存储，不抛异常', () => {
    const file = pluginStorageFile(base, 'demo.broken')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ not json', 'utf-8')

    const storage = new PluginStorage({ userDataDir: base })
    expect(storage.snapshot('demo.broken')).toEqual({})
    storage.set('demo.broken', 'ok', true)
    storage.flush('demo.broken')
    expect(readFile('demo.broken')).toEqual({ ok: true })
  })
})
