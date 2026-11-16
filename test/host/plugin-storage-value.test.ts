import { describe, expect, it } from 'vitest'
import {
  assertStorableValue,
  UnstorableValueError
} from '../../packages/services/plugins/src/backend/storage-value.ts'

describe('assertStorableValue', () => {
  it('JSON 能表达的值都放行', () => {
    expect(() => assertStorableValue('k', null)).not.toThrow()
    expect(() => assertStorableValue('k', 'text')).not.toThrow()
    expect(() => assertStorableValue('k', 42)).not.toThrow()
    expect(() => assertStorableValue('k', true)).not.toThrow()
    expect(() => assertStorableValue('k', [1, 'a', { b: null }])).not.toThrow()
    expect(() => assertStorableValue('k', { nested: { list: [1, 2] } })).not.toThrow()
    expect(() => assertStorableValue('k', Object.create(null) as object)).not.toThrow()
  })

  it('落盘会变形的值直接拒绝', () => {
    expect(() => assertStorableValue('k', () => 1)).toThrow(UnstorableValueError)
    expect(() => assertStorableValue('k', Symbol('s'))).toThrow(UnstorableValueError)
    expect(() => assertStorableValue('k', undefined)).toThrow(UnstorableValueError)
    expect(() => assertStorableValue('k', 10n)).toThrow(UnstorableValueError)
    expect(() => assertStorableValue('k', Number.NaN)).toThrow(UnstorableValueError)
    expect(() => assertStorableValue('k', Number.POSITIVE_INFINITY)).toThrow(UnstorableValueError)
    expect(() => assertStorableValue('k', new Map())).toThrow(UnstorableValueError)
    expect(() => assertStorableValue('k', new Set([1]))).toThrow(UnstorableValueError)
    expect(() => assertStorableValue('k', new Date())).toThrow(UnstorableValueError)
    expect(() => assertStorableValue('k', new (class Point {})())).toThrow(UnstorableValueError)
  })

  it('嵌套里的坏值也要拒绝，并带出键路径', () => {
    expect(() => assertStorableValue('k', { a: [{ b: () => 1 }] })).toThrow(/k\.a\.0\.b/)
  })

  it('循环引用不会让校验自己栈溢出', () => {
    const value: Record<string, unknown> = {}
    value.self = value
    expect(() => assertStorableValue('k', value)).toThrow(/循环引用/)
  })

  it('同一个对象被两处引用不算循环', () => {
    const shared = { a: 1 }
    expect(() => assertStorableValue('k', { one: shared, two: shared })).not.toThrow()
  })
})
