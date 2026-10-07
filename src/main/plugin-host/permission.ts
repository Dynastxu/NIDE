export class PermissionManager {
  private permissions = new Map<string, Set<string>>()

  // 加载插件时，注册它声明的权限
  register(pluginId: string, declaredPermissions: string[]): void {
    this.permissions.set(pluginId, new Set(declaredPermissions))
  }

  // 检查插件是否有某个权限
  check(pluginId: string, required: string): boolean {
    const perms = this.permissions.get(pluginId)
    if (!perms) return false
    return perms.has(required)
  }

  unregister(pluginId: string): void {
    this.permissions.delete(pluginId)
  }
}

export const permissionManager = new PermissionManager()
