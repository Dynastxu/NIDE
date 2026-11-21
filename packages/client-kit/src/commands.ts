type CommandHandler = (...args: readonly unknown[]) => unknown

const commands = new Map<string, CommandHandler>()

/**
 * 客户端命令表：窗口 chrome（菜单 / 快捷键）与功能包之间的最小接缝。
 *
 * 为什么不是直接 import：菜单属于窗口，编辑器属于功能包；窗口 import 功能包的
 * `saveActiveTab` 会让「窗口知道所有功能」的老问题回来，也会挡住编辑器独立成包。
 * 让编辑器在 `apply` 里注册 `editor.save`、窗口只 `runCommand('editor.save')`，
 * 两边就只依赖 client-kit 这一层。
 *
 * 命令的 id 是稳定契约（`<域>.<动作>`）；重复注册直接抛错 —— 装配错误要在启动期暴露，
 * 而不是让后注册的悄悄覆盖前一个。
 */
export function registerCommand(id: string, handler: CommandHandler): () => void {
  if (commands.has(id)) throw new Error(`command "${id}" is already registered`)
  commands.set(id, handler)

  return () => {
    if (commands.get(id) === handler) commands.delete(id)
  }
}

export function runCommand<T = unknown>(id: string, ...args: readonly unknown[]): T {
  const handler = commands.get(id)
  if (!handler) throw new Error(`command "${id}" is not registered`)
  return handler(...args) as T
}

export function hasCommand(id: string): boolean {
  return commands.has(id)
}
