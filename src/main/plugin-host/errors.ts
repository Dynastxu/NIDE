class PermissionDeniedError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly permission: string
  ) {
    super(`Plugin ${pluginId} permission denied: ${permission}`)
    this.name = 'PermissionDeniedError'
  }
}

class OperationExceedsWorkspaceError extends PermissionDeniedError {
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
