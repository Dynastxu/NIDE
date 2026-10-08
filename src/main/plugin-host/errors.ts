/**
 * 插件宿主抛给插件沙箱的错误类型。
 *
 * **每个类都必须 `export`。** 这个文件曾经一个 export 都没有，于是 TypeScript
 * 把它当成**全局脚本**而不是模块，两个类被隐式挂到全局作用域上 ——
 * sandbox.ts 能直接 `new PermissionDeniedError(...)` 而不 import 就是这么来的。
 *
 * 后果不只是"不干净"：任何文件里随手写个同名标识符就会撞上它，而且 eslint 的
 * no-unused-vars 会一直把没被 import 的那个类报成"定义了却从未使用"。
 * 显式 export + 显式 import 才是正常模块。
 */

export class PermissionDeniedError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly permission: string
  ) {
    super(`Plugin ${pluginId} permission denied: ${permission}`)
    this.name = 'PermissionDeniedError'
  }
}

export class OperationExceedsWorkspaceError extends PermissionDeniedError {
  constructor(
    public readonly pluginId: string,
    public readonly permission: string,
    public readonly workspaceRoot: string,
    public readonly attemptedPath: string
  ) {
    super(pluginId, permission)
    this.name = 'OperationExceedsWorkspaceError'
  }
}
