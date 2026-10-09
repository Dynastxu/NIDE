/**
 * 主进程日志实现：electron-log 的配置与全局 sink。
 *
 * 职责边界很清楚 —— 这里只管「往哪儿写、写到什么程度」，消息的级别判断与
 * 形状由 `@shared/logger` 的门面负责。业务代码不 import 这个文件，
 * 而是通过 `loggerFor(scope)` 拿到门面实例。
 *
 * 顺带说明为什么主进程只有这一个文件写盘：
 * electron-log 会把**渲染进程**发来的日志也交给本进程的 file transport
 * （见 node/transports/ipc.js 收包后走 processMessage），于是三个进程的日志
 * 天然落在同一份文件里并按时间交错 —— 排查「渲染进程报错时主进程在做什么」
 * 这类问题时，分文件的方案反而要先对齐两份时间轴。
 */

import { app } from 'electron'
import log from 'electron-log/main'
import {
  DEFAULT_LOG_LEVEL,
  createLogger,
  parseLogLevel,
  type LogLevel,
  type LogMessage,
  type Logger
} from '@shared/logger'
import { FILE_FORMAT, buildLogMessage } from './format'

/** 日志文件的轮转上限。超过就改名成 main.old.log，当前文件清空重写 */
const MAX_FILE_SIZE = 2 * 1024 * 1024

/** 级别阈值：解析一次，主进程与渲染进程共用同一个结论 */
let threshold: LogLevel = DEFAULT_LOG_LEVEL

/** 按 scope 缓存门面实例 */
const instances = new Map<string, Logger>()

/**
 * 缓存上限。
 *
 * scope 大部分来自代码里的字面量，但也有一个来自 IPC 载荷（渲染进程转发），
 * 那是**外部输入**。不设上限的话，一个不断变换 scope 的渲染进程就能让这张表
 * 无限增长。超限时直接退化成「不缓存」，不引入淘汰算法 —— 真实项目里
 * 模块名是有限的几十个，永远不会走到这条分支。
 */
const MAX_INSTANCES = 64

function configureTransports(): void {
  const file = log.transports.file
  file.fileName = 'main.log'
  file.maxSize = MAX_FILE_SIZE
  // 同步写：进程崩溃时异步缓冲里的最后几条日志会丢，而崩溃前的日志恰恰最值钱
  file.sync = true
  file.level = 'silly'
  file.format = FILE_FORMAT

  const consoleTransport = log.transports.console
  consoleTransport.level = app.isPackaged ? 'warn' : 'silly'
  /**
   * 终端里只显示**主进程**的日志。
   *
   * 渲染进程的日志经 IPC 汇总到这里后会走主进程的全部 transport，不过滤的话
   * 渲染进程的每条 warn/error 都会来终端刷一行 —— 而它在 DevTools 里本来就
   * 已经出现过了。文件里仍然两者都留，那边才是完整记录。
   */
  consoleTransport.writeFn = ({ message }) => {
    if (message.variables?.processType === 'renderer') return
    console.log(...(message.data as unknown[]))
  }

  // 主进程日志不再回灌渲染进程的 DevTools：这条通道的方向是反的，用不上
  log.transports.ipc.level = false

  log.variables.processType = 'main'
}

/**
 * 全局兜底。没有这些钩子，主进程崩溃与渲染进程白屏在现场不留任何痕迹。
 *
 * 刻意关掉 electron-log 默认的错误弹窗（showDialog: false）：一个后台的
 * 未处理 rejection 不该打断用户写作，落盘即可，事后能查。
 */
function installCrashHooks(renderer: Logger): void {
  log.errorHandler.startCatching({ showDialog: false })

  // startCatching 只装 uncaughtException / unhandledRejection，进程消失要自己听
  app.on('render-process-gone', (_event, webContents, details) => {
    renderer.error('Renderer process gone', {
      reason: details.reason,
      exitCode: details.exitCode,
      url: webContents.getURL()
    })
  })

  app.on('child-process-gone', (_event, details) => {
    renderer.error('Child process gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode
    })
  })
}

/**
 * 安装日志系统。必须在 `app.whenReady()` **之前**调用：
 *
 * 1. 它接管主进程的 `console`（electron-log 在初始化时改写 console 方法），
 *    越早接管，启动期的日志越不容易漏进「只在终端、不进文件」的缝隙。
 * 2. 文件路径取 `app.getPath('userData')`，首次写盘时求值；写盘由日志触发，
 *    所以第一行日志落地之前配置必须已经就位。
 */
export function installLogger(): Logger {
  threshold = parseLogLevel(process.env['NIDE_LOG_LEVEL'])

  configureTransports()

  /**
   * 只初始化 IPC 侧的日志桥接。这里**不**注册会话级 preload：宿主本身就有
   * preload，在那里显式转出日志出口，比让 electron-log 往每个 session 挂文件
   * 更可控（也就不会出现「两个 preload 抢同一个全局」的问题）。
   */
  log.initialize({ preload: false })

  const root = loggerFor('app')
  installCrashHooks(root)

  root.info('Logger initialized', {
    level: threshold,
    file: log.transports.file.getFile().path,
    dev: !app.isPackaged
  })

  return root
}

/** 当前级别阈值。建窗时喂进启动参数，保证渲染进程与主进程判定一致 */
export function getLogLevel(): LogLevel {
  return threshold
}

/** 取一个带 scope 的门面实例。同一 scope 复用同一个实例 */
export function loggerFor(scope: string): Logger {
  const cached = instances.get(scope)
  if (cached) return cached

  const instance = createLogger(scope, { write: writeToElectronLog }, threshold)
  if (instances.size < MAX_INSTANCES) instances.set(scope, instance)
  return instance
}

/**
 * 校验并归一化一条来自 IPC 的日志载荷。
 *
 * 渲染进程发来的一切都当成不可信输入：形状不对就丢掉，而不是让一个
 * `undefined` 一路穿到 formatter 里。级别用门面的解析规则归一化 ——
 * 拼错的级别名会回落成默认级别，不会静默消失。
 */
export function toLogRecord(payload: unknown): LogMessage | null {
  if (typeof payload !== 'object' || payload === null) return null

  const raw = payload as Record<string, unknown>
  const text = raw.text
  if (typeof text !== 'string' || text.length === 0) return null

  const date = typeof raw.date === 'string' ? new Date(raw.date) : new Date()
  const fields = raw.fields

  return {
    date: Number.isNaN(date.getTime()) ? new Date() : date,
    level: parseLogLevel(raw.level),
    scope: typeof raw.scope === 'string' && raw.scope.length > 0 ? raw.scope : 'renderer',
    text,
    ...(typeof fields === 'object' && fields !== null
      ? { fields: fields as Record<string, unknown> }
      : {})
  }
}

function writeToElectronLog(message: LogMessage): void {
  // 走 processMessage 而不是 log.info(...)：进程标记要靠消息的 variables 传递，
  // 而 log.info() 生成的消息里 variables 永远取自 logger 实例（即 main）。
  // 渲染进程经 IPC 转发来的消息只有这条路能带上真正的标记。
  log.processMessage(buildLogMessage(message))
}
