/**
 * 渲染进程日志实现：把日志送进主进程的那一份文件。
 *
 * 渲染进程在 Chromium 沙箱里没有 `fs`，所以这里唯一能做的就是把消息交给
 * preload 暴露的出口（见 preload/index.ts 的 sendLog）。好处是三个进程的日志
 * 最终落在同一个文件里按时间交错，排查时不必对齐两条时间轴。
 *
 * 同时接管 console：渲染进程里散落的 `console.warn` / `console.error` 是主要
 * 的日志来源，不改写它们就等于渲染进程的日志永远只在 DevTools 里，用户报障
 * 时拿不到。改写时仍调用**原始** console 方法，所以 DevTools 里照旧能看到。
 */

import { createLogger, isLevelEnabled, type LogLevel, type Logger } from '@shared/logger'

/** 出口形状与 preload 暴露的 RendererLoggerAPI 一致，缺失时退化成「什么都不发」 */
interface LogBridge {
  error: (text: string, fields?: Record<string, unknown>) => void
  warn: (text: string, fields?: Record<string, unknown>) => void
  info: (text: string, fields?: Record<string, unknown>) => void
  debug: (text: string, fields?: Record<string, unknown>) => void
}

function bridge(): LogBridge | null {
  return window.hostAPI?.log ?? null
}

/** 级别阈值来自启动参数，由主进程统一解析（见 main/logger） */
function bootLevel(): LogLevel {
  return window.__NIDE_BOOT__?.logLevel ?? 'info'
}

const instances = new Map<string, Logger>()

/**
 * 取一个带 scope 的渲染进程 logger。
 *
 * 与主进程侧的 loggerFor 分开实现而不是共用：两侧的出口不同（那边直写文件，
 * 这边发 IPC），硬凑成一个函数就要在里面判断进程，反而更难读。
 */
export function loggerFor(scope: string): Logger {
  const cached = instances.get(scope)
  if (cached) return cached

  const instance = createLogger(
    scope,
    {
      write(message) {
        // 出口缺失（比如 preload 挂了）时静默丢弃：一条发不出去的日志不值得
        // 让业务流程跟着抛错
        const target = bridge()
        if (!target) return
        const fields = { scope: message.scope, ...message.fields }
        if (message.level === 'error') target.error(message.text, fields)
        else if (message.level === 'warn') target.warn(message.text, fields)
        else if (message.level === 'debug') target.debug(message.text, fields)
        else target.info(message.text, fields)
      }
    },
    bootLevel()
  )

  instances.set(scope, instance)
  return instance
}

/** 渲染进程是否已经接管 console。热更新可能重复执行本模块，用标志位挡住 */
let consolePatched = false

export function installRendererLogger(): void {
  installWindowErrorHandlers()
  if (!consolePatched) {
    consolePatched = true
    patchConsole()
  }
}

/**
 * 未捕获错误与未处理的 Promise 拒绝。
 *
 * console 改写盖不住这两类：它们不经过 console，只在 DevTools 里以红色冒出。
 * 用 `window.addEventListener` 而不是 electron-log 的 `errorHandler.startCatching`，
 * 是因为后者的 `preventDefault()` 会压掉 DevTools 的原生显示 —— 排查问题时
 * 那一条红色堆栈比什么都值钱。
 */
function installWindowErrorHandlers(): void {
  const logger = loggerFor('renderer')

  window.addEventListener('error', (event) => {
    logger.error('Uncaught error in renderer', {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      error: event.error
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    logger.error('Unhandled promise rejection in renderer', { reason: event.reason })
  })
}

/**
 * 接管 console。
 *
 * 低于阈值时直接把调用交给原始方法：门面里还会再判一次，但这里先判可以省掉
 * 一次对象构造和一次 IPC。
 *
 * 映射关系：`console.log`/`console.info` -> info，`warn` -> warn，
 * `error` -> error，`debug` -> debug。不把 `log` 归到 debug 是有意的 ——
 * 项目里 `console.log` 一直是「给人看的常规信息」，降级会静默吃掉现有输出。
 *
 * 头一个字符串参数常带模块前缀（`[i18n] ...`），原样留在文本里；scope 统一记成
 * renderer —— 文件里靠 scope 区分进程，靠文本区分模块。
 */
function patchConsole(): void {
  const threshold = bootLevel()
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console)
  }

  const forward = (
    target: LogLevel,
    args: unknown[],
    fallback: (...args: unknown[]) => void
  ): void => {
    if (isLevelEnabled(target, threshold) && bridge()) {
      const logger = loggerFor('renderer')
      const text = args.map(formatArg).join(' ')
      if (target === 'error') logger.error(text)
      else if (target === 'warn') logger.warn(text)
      else if (target === 'debug') logger.debug(text)
      else logger.info(text)
    }
    // 无论发不发 IPC，原生输出都保留：DevTools 里要能看到，且它是最后一道
    // 「至少还有地方可看」的保险
    fallback(...args)
  }

  console.log = (...args: unknown[]) => forward('info', args, original.log)
  console.info = (...args: unknown[]) => forward('info', args, original.info)
  console.warn = (...args: unknown[]) => forward('warn', args, original.warn)
  console.error = (...args: unknown[]) => forward('error', args, original.error)
  console.debug = (...args: unknown[]) => forward('debug', args, original.debug)
}

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
