import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import createDefaultLogger from 'electron-log/src/node/createDefaultLogger.js'
import { buildLogMessage, FILE_FORMAT, toData } from '../src/main/logger/format'
import type { LogLevel, LogMessage } from '@shared/logger'

/**
 * 「主进程消息 -> 磁盘上的一行日志」这一层的测试。
 *
 * 为什么值得单独测：这里用的是 electron-log 的**消息与格式约定**，写错不会报错，
 * 只会让每一行日志少掉正文、或者留下一个字面量 `{text}`，要等真出事翻日志时才
 * 发现。所以这里不只断言我们构造的数据，还**拿真的 electron-log 跑一遍写盘**，
 * 直接检查文件里的那一行 —— 库升级改了约定，这条会立刻红。
 */

/** 造一条门面消息，只写关心的字段 */
function message(partial: Partial<LogMessage> = {}): LogMessage {
  return {
    date: new Date('2026-01-02T03:04:05.123Z'),
    level: 'info',
    scope: 'plugin-host',
    text: 'Plugin host initialization completed',
    ...partial
  }
}

/** 造出「electron-log 收到渲染进程 IPC 包」之后的那种消息（variables 由库补上） */
function fromRenderer(partial: Partial<LogMessage> = {}): LogMessage {
  return Object.assign(message(partial), { variables: { processType: 'renderer' } })
}

describe('toData', () => {
  it('进程标记与 scope 各自独立成元素，正文跟在后面', () => {
    expect(toData(message())).toEqual([
      '[main]',
      '[plugin-host]',
      'Plugin host initialization completed'
    ])
  })

  it('不把 {text} 自己拼进数据里：那只该出现在 transport 的格式串中', () => {
    for (const item of toData(message())) {
      if (typeof item === 'string') expect(item).not.toContain('{text}')
    }
  })

  it('结构化字段作为最后一个元素，已经归一化并序列化成一行', () => {
    const data = toData(message({ fields: { viewId: 'p.a.view', error: new Error('boom') } }))

    expect(data).toHaveLength(4)
    const fields = JSON.parse(String(data[3])) as {
      viewId: string
      error: { name: string; message: string }
    }
    expect(fields.viewId).toBe('p.a.view')
    expect(fields.error.name).toBe('Error')
    expect(fields.error.message).toBe('boom')
  })

  it('没有字段时不追加元素', () => {
    expect(toData(message())).toHaveLength(3)
  })

  it('渲染进程的消息带 renderer 标记', () => {
    expect(toData(fromRenderer())[0]).toBe('[renderer]')
  })
})

describe('buildLogMessage', () => {
  it('把进程标记放进 variables，供 electron-log 合并', () => {
    expect(buildLogMessage(message()).variables).toEqual({ processType: 'main' })
    expect(buildLogMessage(fromRenderer()).variables).toEqual({ processType: 'renderer' })
  })

  it('级别原样透传', () => {
    expect(buildLogMessage(message({ level: 'warn' as LogLevel })).level).toBe('warn')
  })
})

describe('与 electron-log 的真实约定（写盘验证）', () => {
  let dir: string
  let logger: ReturnType<typeof createDefaultLogger>
  let filePath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nide-log-'))
    filePath = path.join(dir, 'test.log')

    /**
     * 假的外部 API：只喂 file transport 取路径时要的那几项。
     *
     * 用 node 侧的默认 logger（file transport 与主进程是同一份实现），但不给它
     * Electron —— 这样测试能验证「真实库把我们的消息写成什么样」，又不需要起应用。
     */
    const externalApi = {
      getPathVariables: () => ({
        appData: dir,
        appName: 'nide-test',
        appVersion: '0.0.0',
        electronDefaultDir: dir,
        home: dir,
        libraryDefaultDir: dir,
        libraryTemplate: dir,
        tempDir: dir,
        userData: dir
      }),
      isElectron: () => false,
      isDev: () => true
    }

    logger = createDefaultLogger({ dependencies: { externalApi }, initializeFn: () => {} })
    logger.transports.file.fileName = 'test.log'
    logger.transports.console.level = false
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function readLines(): string[] {
    if (!fs.existsSync(filePath)) return []
    return fs
      .readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
  }

  it('文件格式串与生产代码用的是同一份约定', () => {
    expect(logger.transports.file.format).toBe(FILE_FORMAT)
  })

  it('{text} 被替换成正文，我们的前缀拼在它前面，字段被序列化', () => {
    logger.processMessage(buildLogMessage(message({ fields: { viewId: 'p.a.view' } })))

    const [line] = readLines()
    expect(line).toContain('Plugin host initialization completed')
    expect(line).toContain('[info]')
    // 两个前缀都在，顺序是「进程标记 -> scope」
    expect(line).toMatch(/\[main]\s*\[plugin-host]\s*Plugin host initialization completed/)
    expect(line).toContain('p.a.view')
    // 最要命的那条：正文里不该剩下字面量占位符
    expect(line).not.toContain('{text}')
  })

  it('渲染进程的消息写成 renderer 标记', () => {
    logger.processMessage(buildLogMessage(fromRenderer({ text: 'Renderer boot completed' })))

    const [line] = readLines()
    expect(line).toMatch(/\[renderer]\s*\[plugin-host]\s*Renderer boot completed/)
  })

  it('每条消息各占一行，时间戳前缀保留', () => {
    logger.processMessage(buildLogMessage(message({ text: 'first' })))
    logger.processMessage(buildLogMessage(message({ text: 'second' })))

    const lines = readLines()
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}]/)
    expect(lines[0]).toContain('first')
    expect(lines[1]).toContain('second')
  })

  it('error 级别的消息原样落盘（不被级别过滤吞掉）', () => {
    logger.processMessage(buildLogMessage(message({ level: 'error', text: 'boom' })))

    const [line] = readLines()
    expect(line).toContain('[error]')
    expect(line).toContain('boom')
  })

  it('带 Error 的字段落盘成可读文本，且整条记录仍是**一行**', () => {
    logger.processMessage(buildLogMessage(message({ fields: { error: new Error('disk full') } })))

    const lines = readLines()
    // 一条日志一行是硬约束：内容若带换行，后面那些行既没有时间戳也没有级别，
    // grep 与按行解析都会断在这里
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('disk full')
    expect(lines[0]).toContain('"name":"Error"')
    expect(lines[0]).toContain('disk full | at')
  })

  it('嵌套字段再多也只是一行', () => {
    logger.processMessage(
      buildLogMessage(
        message({ fields: { view: { id: 'p.a.view', zone: { name: 'rightTop', open: true } } } })
      )
    )

    const lines = readLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"zone":{"name":"rightTop","open":true}')
  })
})
