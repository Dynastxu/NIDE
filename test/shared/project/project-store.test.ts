import { describe, expect, it } from 'vitest'
import {
  MAX_PROJECTS,
  PROJECT_STORE_VERSION,
  emptyProjectStore,
  normalizeProjectPath,
  parseProjectStore,
  projectNameFromPath,
  projectPathKey,
  removeProject,
  upsertProject
} from '@shared/project'
import type { ProjectStore } from '@shared/project'

/**
 * 「打开过的文件夹」这份数据的纯逻辑。
 *
 * 覆盖的都是**会静默出错**的地方：路径末尾的分隔符（同一条记录存成两份）、
 * 坏文件（列表整个消失）、大小写（Windows 上同一目录算两个项目）。
 * 落盘与目录检查依赖 electron / fs，不在这里 —— 那部分要手动跑应用验证。
 */

const WIN = { now: 1000, caseInsensitive: true }
const POSIX = { now: 1000, caseInsensitive: false }

describe('normalizeProjectPath', () => {
  it('去掉末尾的分隔符，让同一条记录只有一种写法', () => {
    expect(normalizeProjectPath('D:\\Novel\\')).toBe('D:\\Novel')
    expect(normalizeProjectPath('/home/me/novel/')).toBe('/home/me/novel')
    expect(normalizeProjectPath('  /home/me/novel  ')).toBe('/home/me/novel')
  })

  it('保留根路径：盘符和单个斜杠都不是「可去掉末尾」的路径', () => {
    expect(normalizeProjectPath('C:\\')).toBe('C:\\')
    expect(normalizeProjectPath('/')).toBe('/')
  })

  it('空输入给空串，调用方据此判断「这个路径不能用」', () => {
    expect(normalizeProjectPath('   ')).toBe('')
    expect(normalizeProjectPath('')).toBe('')
  })
})

describe('projectNameFromPath', () => {
  it('取最后一段作为显示名', () => {
    expect(projectNameFromPath('D:\\Novel\\My Story')).toBe('My Story')
    expect(projectNameFromPath('/home/me/novel')).toBe('novel')
  })

  it('推不出名字时回落成整条路径，而不是空白', () => {
    expect(projectNameFromPath('/')).toBe('/')
  })
})

describe('projectPathKey', () => {
  it('按平台语义决定是否忽略大小写', () => {
    expect(projectPathKey('C:\\Novel', true)).toBe(projectPathKey('c:\\novel', true))
    // 大小写敏感的平台（Linux）上这是两个真实存在的不同目录，不能合并
    expect(projectPathKey('/Home/Novel', false)).not.toBe(projectPathKey('/home/novel', false))
  })
})

describe('parseProjectStore', () => {
  it('坏输入一律回落成空 store，不抛异常', () => {
    for (const raw of [null, undefined, 42, 'nope', [], {}]) {
      expect(parseProjectStore(raw)).toEqual(emptyProjectStore())
    }
  })

  it('版本对不上就整体回落：宁可让用户重选一次，也不按猜测的语义解释数据', () => {
    const raw = {
      version: PROJECT_STORE_VERSION + 1,
      lastOpened: '/a',
      projects: [{ path: '/a', openedAt: 1 }]
    }
    expect(parseProjectStore(raw).projects).toEqual([])
  })

  it('丢掉坏记录，但保留同一份文件里的好记录', () => {
    const store = parseProjectStore({
      version: PROJECT_STORE_VERSION,
      lastOpened: '/good',
      projects: [
        { path: '/good', openedAt: 10 },
        { path: '', openedAt: 20 },
        { path: '/no-timestamp' },
        { openedAt: 30 },
        null,
        'text'
      ]
    })

    expect(store.projects.map((p) => p.path)).toEqual(['/good', '/no-timestamp'])
    // 时间戳缺失的记录给 0，排到最后但不会丢
    expect(store.projects[1].openedAt).toBe(0)
  })

  it('按打开时间倒序排列，并把列表限制在上限内', () => {
    const projects = Array.from({ length: MAX_PROJECTS + 10 }, (_, index) => ({
      path: `/p/${index}`,
      openedAt: index
    }))

    const store = parseProjectStore({ version: PROJECT_STORE_VERSION, lastOpened: null, projects })

    expect(store.projects).toHaveLength(MAX_PROJECTS)
    expect(store.projects[0].openedAt).toBe(MAX_PROJECTS + 9)
  })

  it('lastOpened 只认列表里真的有的值，否则回落到最近一条', () => {
    const known = parseProjectStore({
      version: PROJECT_STORE_VERSION,
      lastOpened: '/b',
      projects: [
        { path: '/a', openedAt: 1 },
        { path: '/b', openedAt: 2 }
      ]
    })
    expect(known.lastOpened).toBe('/b')

    const unknown = parseProjectStore({
      version: PROJECT_STORE_VERSION,
      lastOpened: '/gone',
      projects: [
        { path: '/a', openedAt: 1 },
        { path: '/b', openedAt: 2 }
      ]
    })
    expect(unknown.lastOpened).toBe('/b')
  })
})

describe('upsertProject', () => {
  it('新项目插到最前，并成为 lastOpened', () => {
    const store = upsertProject(emptyProjectStore(), '/a', { now: 1, caseInsensitive: false })
    const next = upsertProject(store, '/b', { now: 2, caseInsensitive: false })

    expect(next.projects.map((p) => p.path)).toEqual(['/b', '/a'])
    expect(next.lastOpened).toBe('/b')
  })

  it('重复打开同一个目录只更新时间并挪到最前，不产生第二条', () => {
    let store = upsertProject(emptyProjectStore(), '/a', { now: 1, caseInsensitive: false })
    store = upsertProject(store, '/b', { now: 2, caseInsensitive: false })
    store = upsertProject(store, '/a', { now: 3, caseInsensitive: false })

    expect(store.projects).toEqual([
      { path: '/a', openedAt: 3 },
      { path: '/b', openedAt: 2 }
    ])
  })

  it('Windows 上同一目录的不同大小写算同一个项目', () => {
    let store = upsertProject(emptyProjectStore(), 'C:\\Novel', WIN)
    store = upsertProject(store, 'c:\\novel', WIN)

    expect(store.projects).toHaveLength(1)
    // 保留最后写进去的那份写法：用户最近一次选的是哪个，列表就显示哪个
    expect(store.projects[0].path).toBe('c:\\novel')
  })

  it('末尾分隔符不影响去重', () => {
    let store = upsertProject(emptyProjectStore(), 'D:\\Novel', WIN)
    store = upsertProject(store, 'D:\\Novel\\', WIN)

    expect(store.projects).toHaveLength(1)
  })

  it('超出上限时丢掉最久没打开的记录', () => {
    let store = emptyProjectStore()
    for (let index = 0; index < MAX_PROJECTS + 5; index++) {
      store = upsertProject(store, `/p/${index}`, { now: index, caseInsensitive: false })
    }

    expect(store.projects).toHaveLength(MAX_PROJECTS)
    expect(store.projects.some((p) => p.path === '/p/0')).toBe(false)
  })
})

describe('removeProject', () => {
  function fixture(): ProjectStore {
    let store = upsertProject(emptyProjectStore(), '/a', { now: 1, caseInsensitive: false })
    store = upsertProject(store, '/b', { now: 2, caseInsensitive: false })
    return store
  }

  it('移除记录并把 lastOpened 交给下一条', () => {
    const next = removeProject(fixture(), '/b', POSIX)

    expect(next.projects.map((p) => p.path)).toEqual(['/a'])
    expect(next.lastOpened).toBe('/a')
  })

  it('移除最后一条之后 lastOpened 是 null，不是指向已删记录的悬空值', () => {
    const one = upsertProject(emptyProjectStore(), '/a', { now: 1, caseInsensitive: false })
    const next = removeProject(one, '/a', POSIX)

    expect(next.projects).toEqual([])
    expect(next.lastOpened).toBeNull()
  })

  it('移除不存在的路径时原样返回（同一个引用，避免无谓落盘）', () => {
    const store = fixture()
    expect(removeProject(store, '/nope', POSIX)).toBe(store)
  })
})
