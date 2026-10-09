/**
 * 日志门面：主进程、预加载、渲染进程共用的**唯一**日志入口。
 *
 * 这一层刻意不依赖 electron-log，也不依赖 Electron 的任何模块 —— 三个进程
 * 都能 import 它，而它只负责「判断级别 + 统一消息形状」，真正往哪儿写由
 * 注入的 LogSink 决定（主进程是 electron-log，预加载与渲染进程是 IPC 转发）。
 *
 * 这样做的理由：日志实现是会被换掉的东西（换成 pino、自研写盘都发生过），
 * 而业务代码里的 `logger.warn(...)` 不该跟着换。调用点只认这里的类型。
 */

/** 日志级别，由重到轻。阈值以下的消息在门面处就被丢掉，不进 sink */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const LEVEL_ORDER: readonly LogLevel[] = ['error', 'warn', 'info', 'debug']

export const DEFAULT_LOG_LEVEL: LogLevel = 'info'

/**
 * 一条日志消息。sink 只认这个形状，不认 console 的可变参数列表 ——
 * 可变参数在跨 IPC 转发时无法保证可序列化，而对象一定可以。
 */
export interface LogMessage {
  date: Date
  level: LogLevel
  /** 输出这条消息的子系统，例如 plugin-host、i18n、window */
  scope: string
  /** 主消息文本。英文，见 AGENTS.md 的日志规范 */
  text: string
  /** 附加结构化字段。跨 IPC 前会被归一化成纯 JSON */
  fields?: Record<string, unknown>
}

export interface LogSink {
  write(message: LogMessage): void
}

export interface Logger {
  error(text: string, fields?: Record<string, unknown>): void
  warn(text: string, fields?: Record<string, unknown>): void
  info(text: string, fields?: Record<string, unknown>): void
  debug(text: string, fields?: Record<string, unknown>): void
  /** 按级别派发，参数是**级别名**。级别来自数据（IPC 载荷）时用它 */
  dispatch(level: LogLevel, text: string, fields?: Record<string, unknown>): void
}

const LOG_LEVELS: readonly string[] = LEVEL_ORDER

/**
 * 把任意输入解析成合法级别。
 *
 * 集中在这里而不是各自解析：环境变量、启动参数、以后可能的设置项都会读级别，
 * 三处各写一遍 `if (raw === 'debug')` 迟早会出现「主进程认 debug、渲染进程不认」
 * 这种半边生效的问题。
 */
export function parseLogLevel(raw: unknown, fallback: LogLevel = DEFAULT_LOG_LEVEL): LogLevel {
  if (typeof raw !== 'string') return fallback
  const normalized = raw.trim().toLowerCase()
  return (LOG_LEVELS as readonly LogLevel[]).includes(normalized as LogLevel)
    ? (normalized as LogLevel)
    : fallback
}

/**
 * 判断一条消息是否达到阈值。
 *
 * 未知级别按「最详细」处理：宁可多打一条，也不要因为名字拼错而静默丢掉日志。
 */
export function isLevelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  const messageIndex = LEVEL_ORDER.indexOf(level)
  const thresholdIndex = LEVEL_ORDER.indexOf(threshold)
  if (messageIndex < 0 || thresholdIndex < 0) return true
  return messageIndex <= thresholdIndex
}

/**
 * 创建一个 logger。
 *
 * scope 是模块名（i18n、plugin-host、window...），会作为日志行的一部分输出，
 * 取代原先手写在每条消息里的 `[plugin-host] ` 前缀 —— 手写前缀的必然结局是
 * 同一个子系统的前缀在不同文件里长得不一样。
 */
export function createLogger(scope: string, sink: LogSink, threshold: LogLevel): Logger {
  const emit =
    (level: LogLevel) =>
    (text: string, fields?: Record<string, unknown>): void => {
      if (!isLevelEnabled(level, threshold)) return
      sink.write({ date: new Date(), level, scope, text, ...(fields ? { fields } : {}) })
    }

  return {
    error: emit('error'),
    warn: emit('warn'),
    info: emit('info'),
    debug: emit('debug'),
    dispatch: (level, text, fields) => emit(level)(text, fields)
  }
}

/**
 * 把任意值归一化成可安全跨进程传递的形状。
 *
 * 必要性：渲染进程经 IPC 发来的 Error、Map、循环引用结构都会被结构化克隆拒绝，
 * 那会让日志转发本身成为崩溃点 —— 一条日志换一次崩溃显然不划算。Error 在这里
 * 被拆成 name/message/stack，其余不可识别的值退化成字符串。
 *
 * 深度有上限，原因是日志的用途是定位问题，不是完整还原对象图；把整棵 React
 * 组件树写进日志对排查没有帮助，只会把文件撑爆。
 *
 * **堆栈折叠成单行**（实测踩过）：暴露的 stack 是多行的，落到按行组织的日志文件
 * 里会把一条记录劈成好几行，后面那些行既没有时间戳也没有级别，grep 与按行解析
 * 都会断在这里。折叠用 ` | ` 而不是删掉，因为排查时那几帧恰恰是最有用的信息。
 */
const MAX_DEPTH = 3

export function normalizeFields(
  fields: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!fields) return undefined

  const seen = new WeakSet<object>()
  const walk = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value !== 'object') {
      return typeof value === 'bigint' ? value.toString() : value
    }

    if (value instanceof Date) return value.toISOString()

    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: flattenStack(value.stack) }
    }

    if (depth >= MAX_DEPTH) return '[Object]'

    if (seen.has(value)) return '[Circular]'
    seen.add(value)

    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1))
    }

    if (value instanceof Map) {
      return Object.fromEntries(
        Array.from(value.entries()).map(([key, item]) => [String(key), walk(item, depth + 1)])
      )
    }

    if (value instanceof Set) {
      return Array.from(value.values()).map((item) => walk(item, depth + 1))
    }

    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      // 函数与 symbol 是「有也白有」的字段，丢掉比留一个 [Function] 干净
      if (typeof item === 'function' || typeof item === 'symbol') continue
      result[key] = walk(item, depth + 1)
    }
    return result
  }

  return walk(fields, 0) as Record<string, unknown>
}

/** 多行堆栈压成单行。本来就没有堆栈时保持 undefined，不造一个 "undefined" 字符串 */
function flattenStack(stack: string | undefined): string | undefined {
  return stack?.replace(/\r?\n\s*/g, ' | ')
}

/**
 * 把归一化后的字段序列化成**一行** JSON。
 *
 * 为什么不由 sink 自己决定格式：结构化字段最容易被实现的默认行为毁掉 —— 用
 * `util.inspect` 之类的调试格式渲染出来是多行的，一条日志就被劈成好几行，而
 * 「一条日志一行」是按行解析和 grep 的前提。序列化成 JSON 还顺带让字段可被
 * 后续的采集/检索工具直接消费。
 *
 * 传进来的必须是 normalizeFields 的结果（深度受限、无循环引用），否则
 * JSON.stringify 可能抛错。
 */
export function stringifyFields(fields: Record<string, unknown>): string {
  return JSON.stringify(fields, (_key, value) => (value === undefined ? null : value)) ?? '{}'
}
