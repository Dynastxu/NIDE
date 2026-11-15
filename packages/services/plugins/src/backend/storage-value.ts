/**
 * 插件存储的值类型约束。
 *
 * `ctx.storage` 的落盘格式是 JSON（`<userData>/plugin-storage/<id>.json`），但它的
 * 同步视图跑在插件后端子进程里，值是经结构化克隆过来的 —— `Map` / `Set` / `BigInt`
 * / 函数都能过界，却**过不了 `JSON.stringify`**：写进内存看起来成功了，落盘时被
 * 悄悄丢掉（`Map` 变成 `{}`，函数直接消失），下次启动读回来才发现数据没了。
 *
 * 所以 `set` 在**写入内存之前**就校验：只接受 JSON 能原样表达的值。失败抛错，插件
 * 立刻知道这次写入无效，而不是过几个小时才发现。
 */

/** 值不能写进插件存储时抛的错（`key` 已经在消息里） */
export class UnstorableValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnstorableValueError'
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const type = typeof value
  if (type !== 'object') return type
  const name = (value as object).constructor?.name
  return name && name !== 'Object' ? name : 'object'
}

/**
 * 校验一个值能否原样落进 JSON 存储。
 *
 * 允许：`null` / 字符串 / 布尔 / 有限数字 / 数组 / 纯对象（原型是 `Object.prototype`
 * 或 `null`）。其余（函数、symbol、`undefined`、`BigInt`、`Map`、`Set`、`Date`、
 * 类实例、循环引用、`NaN` / `Infinity`）一律抛 {@link UnstorableValueError}。
 */
export function assertStorableValue(key: string, value: unknown): void {
  walk(key, value, new Set())
}

function walk(key: string, value: unknown, stack: Set<object>): void {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return
    case 'number':
      if (Number.isFinite(value)) return
      throw new UnstorableValueError(`storage.set("${key}") 不接受非有限数字（JSON 会写成 null）`)
    case 'undefined':
      throw new UnstorableValueError(`storage.set("${key}") 不接受 undefined（落盘时会整个键消失）`)
    case 'object':
      break
    default:
      throw new UnstorableValueError(`storage.set("${key}") 不接受 ${typeof value}`)
  }

  if (value === null) return
  const object = value as object

  if (stack.has(object)) {
    throw new UnstorableValueError(`storage.set("${key}") 不接受循环引用`)
  }

  if (Array.isArray(object)) {
    stack.add(object)
    try {
      for (const item of object) walk(key, item, stack)
    } finally {
      stack.delete(object)
    }
    return
  }

  const prototype = Object.getPrototypeOf(object)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new UnstorableValueError(
      `storage.set("${key}") 只接受普通对象与数组，收到 ${describe(object)}（落盘时会被改成普通对象）`
    )
  }

  stack.add(object)
  try {
    for (const [childKey, child] of Object.entries(object as Record<string, unknown>)) {
      walk(`${key}.${childKey}`, child, stack)
    }
  } finally {
    stack.delete(object)
  }
}
