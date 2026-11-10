import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildBackendFlags,
  ensureWriteRoots,
  resolveWorkerEntry
} from '../../packages/services/plugins/src/backend/runtime.ts'
import { PluginManager } from '../../packages/services/plugins/src/plugins.ts'
import { resolvePermissions } from '../../packages/contracts/src/plugin-api/permissions.ts'
import type { PluginPermissions } from '../../packages/contracts/src/plugin-api/permissions.ts'

let base = ''
let builtinDir = ''

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'nide-backend-'))
  builtinDir = path.join(base, 'builtin')
  fs.mkdirSync(builtinDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

function writePlugin(
  dir: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {}
): string {
  const pluginDir = path.join(builtinDir, dir)
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8')
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(pluginDir, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, 'utf-8')
  }
  return pluginDir
}

function manager(): PluginManager {
  return new PluginManager({
    builtinDir,
    thirdPartyDir: path.join(base, 'user'),
    preferencePath: path.join(base, 'preference.json')
  })
}

function permissions(overrides: Partial<PluginPermissions> = {}): PluginPermissions {
  return { trust: 'sandboxed', ...overrides }
}

describe('buildBackendFlags', () => {
  const paths = {
    workerEntry: 'C:\\app\\worker.js',
    pluginDir: 'C:\\plugins\\demo',
    project: 'C:\\work\\novel',
    userData: 'C:\\users\\u\\NIDE'
  }

  function resolved(declared: PluginPermissions): ReturnType<typeof resolvePermissions> {
    return resolvePermissions(declared, {
      project: paths.project,
      userData: paths.userData,
      pluginDir: paths.pluginDir,
      home: 'C:\\users\\u',
      temp: 'C:\\Temp'
    })
  }

  it('完全信任不加任何限制参数', () => {
    const flags = buildBackendFlags({
      trust: 'full',
      permissions: resolved({ trust: 'full', fs: { read: [paths.project] } }),
      workerEntry: paths.workerEntry,
      pluginDir: paths.pluginDir
    })
    expect(flags).toEqual([])
  })

  it('受限插件把 worker / 插件目录 / 声明目录变成可读，写作用域再加可写', () => {
    const flags = buildBackendFlags({
      trust: 'sandboxed',
      permissions: resolved(
        permissions({
          fs: { read: [paths.project], write: [`${paths.userData}\\notes`] }
        })
      ),
      workerEntry: paths.workerEntry,
      pluginDir: paths.pluginDir
    })

    expect(flags[0]).toBe('--permission')
    expect(flags).toContain(`--allow-fs-read=${paths.workerEntry}`)
    expect(flags).toContain(`--allow-fs-read=${paths.pluginDir}`)
    expect(flags).toContain(`--allow-fs-read=${paths.project}`)
    expect(flags).toContain(`--allow-fs-write=${paths.userData}\\notes`)
    // 写作用域也要能读（否则列目录都做不到）
    expect(flags).toContain(`--allow-fs-read=${paths.userData}\\notes`)
    expect(flags).not.toContain('--allow-child-process')
  })

  it('声明 exec 才放开子进程权限', () => {
    const flags = buildBackendFlags({
      trust: 'sandboxed',
      permissions: resolved(permissions({ exec: [{ bin: 'git' }] })),
      workerEntry: paths.workerEntry,
      pluginDir: paths.pluginDir
    })
    expect(flags).toContain('--allow-child-process')
  })
})

describe('ensureWriteRoots', () => {
  it('预建声明的可写目录（Node 权限模型不会替插件建目录）', () => {
    const target = path.join(base, 'notes', 'chapters')
    const resolved = resolvePermissions(permissions({ fs: { write: [target] } }), {
      userData: base,
      pluginDir: builtinDir,
      home: base,
      temp: base
    })

    ensureWriteRoots(resolved)
    expect(fs.existsSync(target)).toBe(true)
  })
})

describe('manifest.main 解析', () => {
  it('目录内的 main 被解析成绝对路径，并标记 hasBackend', () => {
    writePlugin(
      'with-backend',
      { id: 'demo.backend', name: 'Backend', version: '1.0.0', main: 'dist/main.js' },
      { 'dist/main.js': 'export default {}' }
    )

    const plugins = manager()
    const plugin = plugins.list()[0]
    expect(plugin.hasBackend).toBe(true)
    expect(plugins.backendEntryOf('demo.backend')).toBe(
      path.join(builtinDir, 'with-backend', 'dist', 'main.js')
    )
  })

  it('没有 main 的插件 hasBackend=false', () => {
    writePlugin('ui-only', { id: 'demo.ui', name: 'UI', version: '1.0.0' })
    const plugin = manager().list()[0]
    expect(plugin.hasBackend).toBe(false)
  })

  it('跑出插件目录的 main 被忽略（插件本身仍然加载）', () => {
    writePlugin('escape', {
      id: 'demo.escape',
      name: 'Escape',
      version: '1.0.0',
      main: '../../outside.js'
    })
    fs.writeFileSync(path.join(base, 'outside.js'), 'export default {}', 'utf-8')

    const plugins = manager()
    expect(plugins.list()[0]?.hasBackend).toBe(false)
    expect(plugins.backendEntryOf('demo.escape')).toBeUndefined()
  })

  it('声明了 main 但文件不存在时忽略后端', () => {
    writePlugin('missing', {
      id: 'demo.missing',
      name: 'Missing',
      version: '1.0.0',
      main: 'dist/main.js'
    })
    const plugins = manager()
    expect(plugins.list()[0]?.hasBackend).toBe(false)
  })
})

describe('resolveWorkerEntry', () => {
  it('指向真实存在的 worker 入口（源码树是 .ts）', () => {
    const entry = resolveWorkerEntry()
    expect(fs.existsSync(entry)).toBe(true)
    expect(path.basename(entry)).toMatch(/^worker\.(js|ts)$/)
  })
})
