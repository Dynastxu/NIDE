import { describe, expect, it } from 'vitest'
import {
  FULL_TRUST,
  allowsLegacy,
  isPathWithinScopes,
  normalizeAbsolutePath,
  parsePluginPermissions,
  resolvePermissions
} from '@nide/contracts/plugin-api'

describe('permissions：解析', () => {
  it('缺省 = 完全信任', () => {
    const result = parsePluginPermissions(undefined)
    expect(result.errors).toEqual([])
    expect(result.permissions).toEqual(FULL_TRUST)
  })

  it('老数组归一化成 full + os / net', () => {
    const result = parsePluginPermissions(['network', 'secrets:own', 'clipboard:write'])
    expect(result.errors).toEqual([])
    expect(result.permissions).toEqual({
      trust: 'full',
      net: { mode: 'all', allowPlainHttp: false, allowPrivate: true },
      os: { clipboard: 'write' },
      secrets: 'own'
    })
  })

  it('未知的老权限只警告，不阻断', () => {
    const result = parsePluginPermissions(['fs:read', 'network'])
    expect(result.errors).toEqual([])
    expect(result.warnings.join('')).toContain('fs:read')
    expect(result.permissions?.net?.mode).toBe('all')
  })

  it('v2 缺 trust 时默认 sandboxed', () => {
    const result = parsePluginPermissions({
      fs: { read: ['${project}'], write: ['${userData}/out/**'] }
    })
    expect(result.errors).toEqual([])
    expect(result.permissions).toEqual({
      trust: 'sandboxed',
      fs: {
        read: ['${project}'],
        write: ['${userData}/out/**']
      }
    })
  })

  it('未知字段、坏路径、危险路径都报错', () => {
    const result = parsePluginPermissions({
      trust: 'sandboxed',
      fs: { read: ['relative/path', '/a/../b', '/a/*/b'] },
      nope: true
    })
    const errors = result.errors.join('\n')
    expect(errors).toContain('未知字段 "nope"')
    expect(errors).toContain('必须是绝对路径')
    expect(errors).toContain('不能包含 ..')
    expect(errors).toContain('段内通配')
    expect(result.permissions).toBeUndefined()
  })

  it('net.allowlist 必须给 hosts；sandboxed 不能用 mode=all', () => {
    const allowlist = parsePluginPermissions({
      trust: 'sandboxed',
      net: { mode: 'allowlist' }
    })
    expect(allowlist.errors.join('')).toContain('必须给出 hosts')

    const all = parsePluginPermissions({ trust: 'sandboxed', net: { mode: 'all' } })
    expect(all.errors.join('')).toContain('只允许与 trust = "full" 搭配')
  })

  it('exec 的 args 必须是合法正则', () => {
    const result = parsePluginPermissions({
      trust: 'full',
      exec: [{ bin: 'git', args: ['[bad'] }]
    })
    expect(result.errors.join('')).toContain('非法正则')
  })

  it('未知的路径变量只警告', () => {
    const result = parsePluginPermissions({
      trust: 'sandboxed',
      fs: { read: ['${projectRoot}'] }
    })
    expect(result.errors).toEqual([])
    expect(result.warnings.join('')).toContain('未知变量 ${projectRoot}')
  })

  it('非对象非数组直接报错', () => {
    expect(parsePluginPermissions('network').errors).not.toEqual([])
  })
})

describe('permissions：展开与判断', () => {
  const variables = {
    project: 'C:\\work\\novel',
    userData: 'C:\\Users\\u\\AppData\\Roaming\\NIDE',
    pluginDir: 'C:\\Users\\u\\AppData\\Roaming\\NIDE\\plugins\\demo',
    temp: 'C:\\Temp',
    home: 'C:\\Users\\u'
  }

  it('展开 ${project} 与 ${pluginDir}，缺变量的进 unresolved', () => {
    const resolved = resolvePermissions(
      {
        trust: 'sandboxed',
        fs: { read: ['${project}', '${pluginDir}/data', '${missing}/x'] }
      },
      variables
    )
    expect(resolved.fs.read.resolved).toEqual([
      'C:\\work\\novel',
      'C:\\Users\\u\\AppData\\Roaming\\NIDE\\plugins\\demo\\data'
    ])
    expect(resolved.fs.read.unresolved).toEqual(['${missing}/x'])
    expect(resolved.unresolved).toEqual(['${missing}/x'])
  })

  it('缺省时 net = none、secrets = none、fs 为空', () => {
    const resolved = resolvePermissions(undefined, variables)
    expect(resolved.trust).toBe('full')
    expect(resolved.net.mode).toBe('none')
    expect(resolved.secrets).toBe('none')
    expect(resolved.fs.read.resolved).toEqual([])
  })

  it('路径作用域按目录前缀判断，不放过同名前缀', () => {
    expect(isPathWithinScopes(['C:\\work\\novel'], 'C:\\work\\novel\\a.md', true)).toBe(true)
    expect(isPathWithinScopes(['C:\\work\\novel'], 'C:\\work\\novelist\\a.md', true)).toBe(false)
    expect(isPathWithinScopes(['/home/u/novel'], '/home/u/novel/a.md', false)).toBe(true)
    expect(isPathWithinScopes(['/home/u/novel'], '/home/u/novel-2/a.md', false)).toBe(false)
  })

  it('大小写：Windows 不敏感，POSIX 敏感', () => {
    expect(isPathWithinScopes(['c:\\work\\Novel'], 'C:\\Work\\novel\\A.md', true)).toBe(true)
    expect(isPathWithinScopes(['/home/u/Novel'], '/home/u/novel/a.md', false)).toBe(false)
  })

  it('.. 越过根 / 相对路径归一化成 null', () => {
    expect(normalizeAbsolutePath('C:\\a\\..\\..\\b', true)).toBeNull()
    expect(normalizeAbsolutePath('relative/path', false)).toBeNull()
    expect(normalizeAbsolutePath('C:\\a\\b\\..\\c', true)).toBe('c:/a/c')
  })

  it('allowsLegacy 把老字符串翻译成 v2', () => {
    const permissions = parsePluginPermissions(['network', 'clipboard:write']).permissions
    expect(allowsLegacy(permissions, 'network')).toBe(true)
    expect(allowsLegacy(permissions, 'clipboard:write')).toBe(true)
    expect(allowsLegacy(permissions, 'secrets:own')).toBe(false)
    expect(allowsLegacy(permissions, 'nonsense')).toBe(false)
  })
})
