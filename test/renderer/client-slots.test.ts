import { describe, expect, it, vi } from 'vitest'
import {
  resolveSlot,
  SlotRegistry,
  type SlotComponent,
  type SlotEntry
} from '../../packages/client-ui-slots/src'

/**
 * slot 注册表的三种语义。
 *
 * 这套逻辑决定「窗口怎么把功能包画出来」，错了不会 typecheck 失败，只会在界面上
 * 少一块、多一块或卡死重渲染。所以把 single / keyed / list、快照稳定性、订阅、
 * 非法注册都钉住；React 侧的渲染只依赖 `resolveSlot` 这个纯函数，也能在这里测。
 */
const A: SlotComponent = () => null
const B: SlotComponent = () => null
const C: SlotComponent = () => null

describe('SlotRegistry', () => {
  it('single：第一个注册者生效，注销后回落到下一个', () => {
    const slots = new SlotRegistry()
    slots.register('root', A)
    const disposeB = slots.register('root', B)

    expect(slots.kindOf('root')).toBe('single')
    expect(slots.get('root')).toBe(A)
    expect(slots.count('root')).toBe(2)

    disposeB()
    // 注销函数可重复调用，不会误删别人的注册
    disposeB()
    expect(slots.count('root')).toBe(1)
    expect(slots.get('root')).toBe(A)
  })

  it('keyed：按 key 取，同 key 后注册覆盖，不同 key 并存', () => {
    const slots = new SlotRegistry()
    slots.declare('main', 'keyed')

    slots.register({ name: 'main', key: 'editor' }, A)
    slots.register({ name: 'main', key: 'preview' }, B)

    expect(slots.getKeyed('main', 'editor')).toBe(A)
    expect(slots.getKeyed('main', 'preview')).toBe(B)
    expect(slots.get('main')).toBe(A)
    expect(slots.count('main')).toBe(2)

    slots.register({ name: 'main', key: 'editor' }, C)
    expect(slots.getKeyed('main', 'editor')).toBe(C)
    expect(slots.count('main')).toBe(2)
  })

  it('list：按 order 排，同 order 保留注册顺序', () => {
    const slots = new SlotRegistry()
    slots.declare('overlay', 'list')

    slots.register({ name: 'overlay', order: 10 }, A)
    slots.register({ name: 'overlay', order: 0 }, B)
    slots.register({ name: 'overlay', order: 0 }, C)

    expect(slots.list('overlay').map((entry) => entry.component)).toEqual([B, C, A])
  })

  it('非法注册：keyed 缺 key、list 带 key、声明冲突都抛错', () => {
    const slots = new SlotRegistry()
    slots.declare('main', 'keyed')
    expect(() => slots.register({ name: 'main' }, A)).toThrow(/key/)

    slots.declare('overlay', 'list')
    expect(() => slots.register({ name: 'overlay', key: 'x' }, A)).toThrow(/key/)

    expect(() => slots.declare('main', 'list')).toThrow(/already declared/)
  })

  it('未声明默认 single；声明为 list 后按新种类解释已有注册', () => {
    const slots = new SlotRegistry()
    slots.register('overlay', A)
    slots.register('overlay', B)

    slots.declare('overlay', 'list')
    expect(slots.list('overlay').map((entry) => entry.component)).toEqual([A, B])
  })

  it('把已有 occupant 的槽声明成 keyed：没有 key 就拒绝', () => {
    const slots = new SlotRegistry()
    slots.register('main', A)
    expect(() => slots.declare('main', 'keyed')).toThrow(/without a key/)
  })

  it('snapshot 同版本返回同一引用，变更后才换', () => {
    const slots = new SlotRegistry()
    const empty = slots.snapshot('root')
    expect(slots.snapshot('root')).toBe(empty)

    slots.register('root', A)
    const one = slots.snapshot('root')
    expect(one).not.toBe(empty)
    expect(slots.snapshot('root')).toBe(one)

    slots.register('root', B)
    expect(slots.snapshot('root')).not.toBe(one)
  })

  it('subscribe 在注册 / 覆盖 / 注销时通知，取消后不再通知', () => {
    const slots = new SlotRegistry()
    slots.declare('main', 'keyed')

    const listener = vi.fn()
    const unsubscribe = slots.subscribe('main', listener)

    const disposeA = slots.register({ name: 'main', key: 'editor' }, A)
    expect(listener).toHaveBeenCalledTimes(1)

    const disposeB = slots.register({ name: 'main', key: 'editor' }, B)
    expect(listener).toHaveBeenCalledTimes(2)

    // 被覆盖的旧 occupant 的注销函数必须是无操作：不能把新 occupant 删掉。
    disposeA()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(slots.getKeyed('main', 'editor')).toBe(B)

    disposeB()
    expect(listener).toHaveBeenCalledTimes(3)

    unsubscribe()
    slots.register({ name: 'main', key: 'editor' }, C)
    expect(listener).toHaveBeenCalledTimes(3)
  })
})

describe('resolveSlot', () => {
  const entries: readonly SlotEntry[] = [
    { id: 'a', component: A, order: 0 },
    { id: 'b', component: B, key: 'preview', order: 0 },
    { id: 'c', component: C, key: 'preview', order: 10 }
  ]

  it('single 只取第一个', () => {
    expect(resolveSlot('single', entries).map((entry) => entry.id)).toEqual(['a'])
  })

  it('keyed 按 activeKey 过滤；没有 key 时为空', () => {
    expect(resolveSlot('keyed', entries, 'preview').map((entry) => entry.id)).toEqual(['b', 'c'])
    expect(resolveSlot('keyed', entries)).toEqual([])
    expect(resolveSlot('keyed', entries, 'missing')).toEqual([])
  })

  it('list 原样返回（注册表已排好序）', () => {
    expect(resolveSlot('list', entries)).toEqual(entries)
  })
})
