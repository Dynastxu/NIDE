import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOG_LEVEL,
  createLogger,
  isLevelEnabled,
  normalizeFields,
  parseLogLevel,
  type LogMessage
} from '@shared/logger'

/**
 * 日志门面的纯逻辑测试。
 *
 * 覆盖的是「哪些消息该出去、出去时是什么形状」—— 真正写盘、格式化的部分在
 * electron-log 里，那属于集成面（见 vitest.config.ts 的说明），靠手跑应用验证。
 */

/** 收集 sink 写出的消息，用来断言门面的行为 */
function collector(): { messages: LogMessage[]; sink: { write(m: LogMessage): void } } {
  const messages: LogMessage[] = []
  return { messages, sink: { write: (message) => messages.push(message) } }
}

describe('级别解析', () => {
  it('接受大小写与空白的变体', () => {
    expect(parseLogLevel(' Debug ')).toBe('debug')
    expect(parseLogLevel('WARN')).toBe('warn')
  })

  it('认不出来时回落到默认级别，而不是静默变成最详细', () => {
    expect(parseLogLevel('verbose')).toBe(DEFAULT_LOG_LEVEL)
    expect(parseLogLevel(undefined)).toBe(DEFAULT_LOG_LEVEL)
    expect(parseLogLevel(42)).toBe(DEFAULT_LOG_LEVEL)
  })
})

describe('级别过滤', () => {
  it('阈值只放行同级与更严重的消息', () => {
    expect(isLevelEnabled('error', 'info')).toBe(true)
    expect(isLevelEnabled('info', 'info')).toBe(true)
    expect(isLevelEnabled('debug', 'info')).toBe(false)
    expect(isLevelEnabled('debug', 'debug')).toBe(true)
  })

  it('阈值是 error 时把 warn / info / debug 全挡掉', () => {
    expect(isLevelEnabled('warn', 'error')).toBe(false)
    expect(isLevelEnabled('info', 'error')).toBe(false)
    expect(isLevelEnabled('error', 'error')).toBe(true)
  })
})

describe('createLogger', () => {
  it('给每条消息补上 scope、级别与时间', () => {
    const { messages, sink } = collector()
    const logger = createLogger('plugin-host', sink, 'debug')

    logger.warn('View has an invalid location')

    expect(messages).toHaveLength(1)
    expect(messages[0].scope).toBe('plugin-host')
    expect(messages[0].level).toBe('warn')
    expect(messages[0].text).toBe('View has an invalid location')
    expect(messages[0].date).toBeInstanceOf(Date)
  })

  it('低于阈值的消息不进 sink', () => {
    const { messages, sink } = collector()
    const logger = createLogger('i18n', sink, 'info')

    logger.debug('Message provider')
    logger.info('Locale resolved')

    expect(messages.map((m) => m.text)).toEqual(['Locale resolved'])
  })

  it('结构化字段随消息一起送出', () => {
    const { messages, sink } = collector()
    const logger = createLogger('host', sink, 'debug')

    logger.error('Failed to open a window', { type: 'settings', code: 7 })

    expect(messages[0].fields).toEqual({ type: 'settings', code: 7 })
  })

  it('没有字段时不生成空 fields 对象', () => {
    const { messages, sink } = collector()
    const logger = createLogger('app', sink, 'debug')

    logger.info('Logger initialized')

    expect(messages[0].fields).toBeUndefined()
  })

  it('dispatch 按传入的级别派发，覆盖所有级别', () => {
    const { messages, sink } = collector()
    const logger = createLogger('renderer', sink, 'debug')

    logger.dispatch('error', 'a')
    logger.dispatch('warn', 'b')
    logger.dispatch('info', 'c')
    logger.dispatch('debug', 'd')

    expect(messages.map((m) => m.level)).toEqual(['error', 'warn', 'info', 'debug'])
  })
})

describe('normalizeFields', () => {
  it('没有字段时原样返回 undefined', () => {
    expect(normalizeFields(undefined)).toBeUndefined()
  })

  it('把 Error 拆成可序列化的形状', () => {
    const result = normalizeFields({ error: new Error('boom') })
    const error = result?.error as { name: string; message: string; stack?: string }

    expect(error.name).toBe('Error')
    expect(error.message).toBe('boom')
    expect(typeof error.stack).toBe('string')
  })

  it('堆栈被压成单行：多行堆栈会把一条日志劈成好几行', () => {
    const error = new Error('boom')
    error.stack = 'Error: boom\n    at one\n    at two'

    const result = normalizeFields({ error })
    const stack = (result?.error as { stack: string }).stack

    expect(stack).not.toContain('\n')
    expect(stack).toBe('Error: boom | at one | at two')
  })

  it('把循环引用替换成占位符，而不是抛异常', () => {
    const node: Record<string, unknown> = { name: 'root' }
    node.self = node

    const result = normalizeFields({ node })
    const normalized = result?.node as Record<string, unknown>

    expect(normalized.name).toBe('root')
    expect(normalized.self).toBe('[Circular]')
  })

  it('超过深度上限的嵌套对象被截断', () => {
    const deep = { a: { b: { c: { d: 'too deep' } } } }
    const normalized = normalizeFields(deep) as Record<string, unknown>
    const a = normalized.a as Record<string, unknown>
    const b = a.b as Record<string, unknown>

    expect(b.c).toBe('[Object]')
  })

  it('丢掉函数与 symbol，保留可打印的值', () => {
    const result = normalizeFields({
      fn: () => undefined,
      sym: Symbol('x'),
      keep: 1,
      flag: true,
      nothing: null
    })

    expect(result).toEqual({ keep: 1, flag: true, nothing: null })
  })

  it('处理 Map / Set / Date / bigint', () => {
    const date = new Date('2026-01-02T03:04:05.000Z')
    const result = normalizeFields({
      map: new Map([['k', 1]]),
      set: new Set(['a']),
      date,
      big: BigInt(10)
    })

    expect(result).toEqual({
      map: { k: 1 },
      set: ['a'],
      date: '2026-01-02T03:04:05.000Z',
      big: '10'
    })
  })
})
