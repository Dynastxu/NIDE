/**
 * 「门面消息 -> electron-log 一条日志」的翻译，单独成模块是为了**能测**。
 *
 * 这一层出错的代价不对称：写盘本身有 electron-log 兜着，但消息形状写错不会报错，
 * 只会让每一行日志少掉正文、或者留下一个字面量 `{text}` / 前缀被吞掉 —— 那要等
 * 真出事翻日志的时候才发现。放在这里就能用单元测试钉住。
 *
 * **关键约束（实测踩过）**：electron-log 只替换**它自己 transport.format** 里的
 * `{text}`，不会处理正文里的占位符。所以前缀必须以独立的字符串元素传进去，由它
 * 在替换时拼到正文前面；把 `{text}` 嵌进我们自己拼的模板里，结果就是正文里原样
 * 留着一个 `{text}`。
 *
 * 不依赖 electron：只有纯字符串与类型。
 */

import { normalizeFields, stringifyFields, type LogLevel, type LogMessage } from '@shared/logger'

/**
 * 文件行的格式。与 electron-log 的 file transport 默认值一致。
 *
 * `{scope}` 由 electron-log 自己替换（它按最长 scope 补空格），所以这里不拼；
 * `{text}` 由它用本条消息的正文替换。
 */
export const FILE_FORMAT = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}'

/** 进程标记：主进程与渲染进程的日志写在同一份文件里，靠它区分 */
export function processTag(message: LogMessage): string {
  // variables 不在门面类型里，它是 electron-log 在写盘前补上的；取不到就算主进程
  const variables = (message as { variables?: { processType?: string } }).variables
  return variables?.processType === 'renderer' ? 'renderer' : 'main'
}

/**
 * 构造 electron-log 的数据行。
 *
 * 形状是 `[进程标记, scope 标记, 正文, 字段?]`：前两个元素由 electron-log 在
 * 渲染格式串时拼到 `{text}` 的位置，正文原样跟随。
 *
 * **字段先自己序列化成一行 JSON**（实测踩过）：交给 electron-log 去渲染对象时，
 * 它用的是 `util.inspect` 的多行格式，一条记录会被劈成好几行 —— 后面那些行既没有
 * 时间戳也没有级别，按行解析与 grep 全断在这里。自己序列化就守住了「一条日志
 * 一行」。字段已经过 normalizeFields，深度有上限，不会因为循环引用而抛错。
 */
export function toData(message: LogMessage): unknown[] {
  const data: unknown[] = [`[${processTag(message)}]`, `[${message.scope}]`, message.text]
  const fields = normalizeFields(message.fields)
  if (fields) data.push(stringifyFields(fields))
  return data
}

/**
 * 组装交给 `log.processMessage` 的完整消息。
 *
 * 走 `processMessage` 而不是 `log.info(...)` 的原因：进程标记要靠 `variables`
 * 传递，而 `log.info()` 生成的消息里 variables 由 electron-log 从 logger 实例上
 * 取（那里永远是 `main`）。渲染进程经 IPC 转发过来的消息只有这条路能带上真
 * 标记：自己构造消息交给它，变量的合并留给库自己处理。
 */
export function buildLogMessage(message: LogMessage): {
  data: unknown[]
  date: Date
  level: LogLevel
  variables: { processType: string }
} {
  return {
    data: toData(message),
    date: message.date,
    level: message.level,
    variables: { processType: processTag(message) }
  }
}
