import { describe, expect, it } from 'vitest'
import { confirmRequested, parseConfirmResponse } from '@shared/confirm'

/**
 * 二次确认契约里那两个**判不可信输入**的纯函数。
 *
 * 它们俩分别是这道门的两端：`confirmRequested` 决定要不要问（错在放宽这一侧，
 * 代价是一次静默的删除），`parseConfirmResponse` 决定一个回答能不能算数（错在
 * 放宽这一侧，代价是别人替用户按了「确定」）。所以下面覆盖的几乎都是坏输入。
 */

describe('confirmRequested', () => {
  it('什么都不传时默认要问', () => {
    expect(confirmRequested(undefined)).toBe(true)
    expect(confirmRequested(null)).toBe(true)
  })

  it('只有显式的 confirm: false 才是「不用问」', () => {
    expect(confirmRequested({ confirm: false })).toBe(false)
  })

  it('其余取值一律按「要问」处理', () => {
    expect(confirmRequested({})).toBe(true)
    expect(confirmRequested({ confirm: true })).toBe(true)
    // 下面这些都是坏载荷：真值判断会把它们当成「不问」，那是最危险的一侧
    expect(confirmRequested({ confirm: 'false' })).toBe(true)
    expect(confirmRequested({ confirm: 0 })).toBe(true)
    expect(confirmRequested({ confirm: null })).toBe(true)
    expect(confirmRequested({ confirm: undefined })).toBe(true)
  })

  it('根本不是对象的载荷不会抛异常，也不会被当成「不用问」', () => {
    expect(confirmRequested('false')).toBe(true)
    expect(confirmRequested(0)).toBe(true)
    expect(confirmRequested(true)).toBe(true)
    expect(confirmRequested([])).toBe(true)
  })
})

describe('parseConfirmResponse', () => {
  it('认得一个完整的回答', () => {
    expect(parseConfirmResponse({ id: 'abc', confirmed: true })).toEqual({
      id: 'abc',
      confirmed: true
    })
    expect(parseConfirmResponse({ id: 'abc', confirmed: false })).toEqual({
      id: 'abc',
      confirmed: false
    })
  })

  it('多出来的字段被丢掉，只留下两个认得的', () => {
    expect(parseConfirmResponse({ id: 'abc', confirmed: true, extra: 1 })).toEqual({
      id: 'abc',
      confirmed: true
    })
  })

  it('缺字段、类型不对、空对象的载荷一律给 null', () => {
    expect(parseConfirmResponse(undefined)).toBeNull()
    expect(parseConfirmResponse(null)).toBeNull()
    expect(parseConfirmResponse('abc')).toBeNull()
    expect(parseConfirmResponse({})).toBeNull()
    expect(parseConfirmResponse({ id: 'abc' })).toBeNull()
    expect(parseConfirmResponse({ confirmed: true })).toBeNull()
    expect(parseConfirmResponse({ id: '', confirmed: true })).toBeNull()
    expect(parseConfirmResponse({ id: 42, confirmed: true })).toBeNull()
    // confirmed 必须是布尔：'true' / 1 这类真值不能被当成「用户点了确认」
    expect(parseConfirmResponse({ id: 'abc', confirmed: 'true' })).toBeNull()
    expect(parseConfirmResponse({ id: 'abc', confirmed: 1 })).toBeNull()
  })
})
