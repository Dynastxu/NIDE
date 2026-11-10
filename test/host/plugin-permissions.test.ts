import { describe, expect, it } from 'vitest'
import { RpcRegistry } from '../../packages/kernel/src/rpc.ts'
import {
  PluginPermissionGuard,
  capabilityOf,
  pathsOf
} from '../../packages/services/plugins/src/permissions.ts'
import type { PluginManager } from '../../packages/services/plugins/src/plugins.ts'
import type { PluginPermissions } from '../../packages/contracts/src/plugin-api/permissions.ts'
import type { RpcRequest } from '../../packages/contracts/src/host-rpc/index.ts'

const PROJECT = 'C:\\work\\novel'
const USER_DATA = 'C:\\Users\\u\\AppData\\Roaming\\NIDE'

const GRANTS: Record<string, PluginPermissions> = {
  'demo.full': { trust: 'full' },
  'demo.reader': {
    trust: 'sandboxed',
    fs: { read: ['${project}'] }
  },
  'demo.writer': {
    trust: 'sandboxed',
    fs: { read: ['${project}'], write: ['${project}\\chapters'] }
  },
  'demo.noFs': { trust: 'sandboxed' }
}

/** 只实现权限检查用到的那两个方法，避免为了测试搭一套插件目录 */
function stubManager(): PluginManager {
  return {
    permissionsOf: (pluginId: string) => GRANTS[pluginId],
    locationOf: () =>
      ({
        dirPath: 'C:\\Users\\u\\AppData\\Roaming\\NIDE\\plugins\\demo',
        source: 'third-party'
      }) as const
  } as unknown as PluginManager
}

function guard(options: { windows?: boolean } = {}): PluginPermissionGuard {
  return new PluginPermissionGuard({
    manager: stubManager(),
    projectRoot: () => PROJECT,
    variables: () => ({
      project: PROJECT,
      userData: USER_DATA,
      home: 'C:\\Users\\u',
      temp: 'C:\\Temp'
    }),
    windows: options.windows ?? true
  })
}

function request(
  pluginId: string | undefined,
  namespace: string,
  method: string,
  args: unknown[] = []
): RpcRequest {
  return {
    type: 'rpc',
    id: 'req-1',
    namespace,
    method,
    args,
    ...(pluginId ? { caller: { pluginId } } : {})
  }
}

describe('PluginPermissionGuard：能力映射', () => {
  it('映射出 fs / net / 管理三类', () => {
    expect(capabilityOf('files', 'readFile')).toBe('fs.read')
    expect(capabilityOf('files', 'writeFile')).toBe('fs.write')
    expect(capabilityOf('gallery', 'create')).toBe('fs.write')
    expect(capabilityOf('config', 'read')).toBe('fs.read')
    expect(capabilityOf('ai', 'open')).toBe('net')
    expect(capabilityOf('plugins', 'install')).toBe('manage')
    expect(capabilityOf('host', 'ping')).toBeNull()
    expect(capabilityOf('i18n', 'payload')).toBeNull()
  })

  it('按方法形状取路径；名字类方法回落到当前项目根', () => {
    expect(pathsOf('files', 'readFile', ['C:\\a.md'], PROJECT)).toEqual(['C:\\a.md'])
    expect(pathsOf('files', 'writeFile', [{ filePath: 'C:\\a.md' }], PROJECT)).toEqual(['C:\\a.md'])
    expect(pathsOf('files', 'createEntry', [{ targetPath: 'C:\\dir' }], PROJECT)).toEqual([
      'C:\\dir'
    ])
    expect(pathsOf('gallery', 'updateRegistry', [{ characters: '角色' }], PROJECT)).toEqual([
      PROJECT
    ])
    expect(pathsOf('config', 'read', [], PROJECT)).toEqual([PROJECT])
    expect(pathsOf('config', 'read', [], undefined)).toEqual([])
    expect(pathsOf('files', 'readFile', [], PROJECT)).toEqual([])
  })
})

describe('PluginPermissionGuard：准入', () => {
  it('核心 UI（没有 caller）一律放行', () => {
    expect(
      guard().authorize(request(undefined, 'files', 'deleteEntry', [{ targetPath: 'D:\\x' }]))
    ).toBeNull()
  })

  it('完全信任的插件不受 fs 限制', () => {
    const result = guard().authorize(
      request('demo.full', 'files', 'deleteEntry', [{ targetPath: 'D:\\anything.txt' }])
    )
    expect(result).toBeNull()
  })

  it('受限插件只能读作用域内的路径', () => {
    const inside = guard().authorize(
      request('demo.reader', 'files', 'readFile', ['C:\\work\\novel\\a.md'])
    )
    expect(inside).toBeNull()

    const outside = guard().authorize(
      request('demo.reader', 'files', 'readFile', ['C:\\work\\other\\a.md'])
    )
    expect(outside?.code).toBe('permission-denied')
    expect(outside?.message).toContain('没有访问')
  })

  it('读作用域不等于写作用域', () => {
    const insideRead = guard().authorize(
      request('demo.reader', 'files', 'writeFile', [
        { filePath: 'C:\\work\\novel\\chapters\\1.md' }
      ])
    )
    expect(insideRead?.code).toBe('permission-denied')
  })

  it('写作用域按目录前缀，且拦住同名前缀', () => {
    const allowed = guard().authorize(
      request('demo.writer', 'files', 'writeFile', [
        { filePath: 'C:\\work\\novel\\chapters\\1.md' }
      ])
    )
    expect(allowed).toBeNull()

    const blocked = guard().authorize(
      request('demo.writer', 'files', 'writeFile', [
        { filePath: 'C:\\work\\novel\\chapters2\\1.md' }
      ])
    )
    expect(blocked?.code).toBe('permission-denied')
  })

  it('没声明 fs 的受限插件读写都被拒绝', () => {
    expect(guard().authorize(request('demo.noFs', 'files', 'readDir', [PROJECT]))?.code).toBe(
      'permission-denied'
    )
  })

  it('取不到路径时拒绝，而不是放行', () => {
    const result = guard().authorize(request('demo.reader', 'files', 'readFile', []))
    expect(result?.code).toBe('permission-denied')
    expect(result?.message).toContain('没有可判定的路径')
  })

  it('受限插件不能管理其它插件', () => {
    expect(
      guard().authorize(request('demo.reader', 'plugins', 'install', ['C:\\evil']))?.code
    ).toBe('permission-denied')
  })

  it('网络调用要求声明 net，且 allowlist 也算声明', () => {
    expect(guard().authorize(request('demo.reader', 'ai', 'open', [{}]))?.code).toBe(
      'permission-denied'
    )
  })

  it('清单里已经没有的插件（卸载后残留调用）被拒绝', () => {
    const result = guard().authorize(request('ghost', 'host', 'ping'))
    expect(result?.code).toBe('unknown-plugin')
  })

  it('没有权限要求的命名空间不受限', () => {
    expect(guard().authorize(request('demo.noFs', 'host', 'ping'))).toBeNull()
  })
})

describe('RpcRegistry：权限拦截接在分发之前', () => {
  it('authorizer 拒绝时返回 permission-denied，handler 不执行', async () => {
    const registry = new RpcRegistry()
    let called = false
    registry.register('files', {
      writeFile: () => {
        called = true
        return { ok: true }
      }
    })
    registry.setAuthorizer(() => ({ code: 'permission-denied', message: 'no' }))

    const response = await registry.invoke(request('demo.reader', 'files', 'writeFile', [{}]))
    expect(called).toBe(false)
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'permission-denied' }
    })
  })

  it('放行时正常执行；没装 authorizer 时行为不变', async () => {
    const registry = new RpcRegistry()
    registry.register('host', { ping: () => 'pong' })

    const allowed = await registry.invoke(request('demo.reader', 'host', 'ping'))
    expect(allowed).toMatchObject({ ok: true, result: 'pong' })
  })
})
