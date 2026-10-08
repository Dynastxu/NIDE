import path from 'node:path'
import { fileService } from '../services/file.service'
import { permissionManager } from './permission'
import { PermissionDeniedError, OperationExceedsWorkspaceError } from './errors'
import type { FileSystemAPI } from '@shared/plugin-api'

// 宿主允许插件访问的工作区根目录（例如用户打开的项目文件夹）
let WORKSPACE_ROOT = process.cwd()

export function setWorkspaceRoot(root: string): void {
  WORKSPACE_ROOT = root
}

// 创建绑定到特定插件的安全文件 API
export function createSandboxedFS(pluginId: string): FileSystemAPI {
  const checkPermission = (action: string): void => {
    if (!permissionManager.check(pluginId, action)) {
      throw new PermissionDeniedError(pluginId, action)
    }
  }

  const resolveSafePath = (userPath: string, action: string): string => {
    // 解析绝对路径，防止 ../ 穿越
    const absolutePath = path.resolve(WORKSPACE_ROOT, userPath)
    // 确保解析后的路径依然在 WORKSPACE_ROOT 内部
    if (!absolutePath.startsWith(WORKSPACE_ROOT)) {
      throw new OperationExceedsWorkspaceError(pluginId, action, WORKSPACE_ROOT, userPath)
    }
    return absolutePath
  }

  return {
    async read(userPath) {
      checkPermission('fs:read')
      return fileService.read(resolveSafePath(userPath, 'fs:read'))
    },
    async write(userPath, content) {
      checkPermission('fs:write')
      return fileService.write(resolveSafePath(userPath, 'fs:write'), content)
    },
    async exists(userPath) {
      checkPermission('fs:read')
      return fileService.exists(resolveSafePath(userPath, 'fs:read'))
    },
    async list(userPath) {
      checkPermission('fs:read')
      return fileService.list(resolveSafePath(userPath, 'fs:read'))
    }
  }
}
