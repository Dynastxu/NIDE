/**
 * 插件权限声明（契约层，浏览器安全）。
 *
 * 形状照 mics：`manifest.json` 的 `permissions` 既接受老的单层字符串数组，
 * 也接受 v2 的结构化对象；解析时统一归一化成 `PluginPermissions`，运行时只认
 * 这一种形状。
 *
 * 两种信任级别：
 * - `full`（缺省）：与今天的模型一致，宿主**不限制**文件 / 网络 / 子进程；
 *   声明的 `os` / `net` 只用于界面展示。老的字符串数组一律归一化成它。
 * - `sandboxed`：宿主按声明做检查。`fs` 的作用域同时约束读与写，
 *   `${project}` / `${userData}` / `${pluginDir}` / `${temp}` / `${home}`
 *   在宿主侧展开成真实目录。
 *
 * 这里刻意不 import `node:path`：渲染进程也要读这份声明（详情页展示），
 * 路径归一化用纯字符串实现。校验失败的声明**不会**被静默降级成 full ——
 * 宿主会整份忽略这个插件（见 packages/services/plugins/src/plugins.ts）。
 */

export type TrustLevel = 'full' | 'sandboxed'

/** 老版本的字符串权限（仍然接受，归一化成 v2） */
export type LegacyPermission =
  /** 访问网络（AI 供应商这类宿主代理调用） */
  | 'network'
  /** 使用自己的密钥仓命名空间 */
  | 'secrets:own'
  /** 用系统浏览器打开链接 */
  | 'shell:openExternal'
  /** 弹系统「打开文件 / 目录」对话框 */
  | 'dialog:open'
  /** 写系统剪贴板 */
  | 'clipboard:write'
  /** 发系统通知 */
  | 'notifications:show'

export interface FsPermissions {
  /** 允许读取的目录；支持末尾 `/**`，不支持段内通配 */
  read?: string[]
  /** 允许写入 / 删除 / 改名的目录 */
  write?: string[]
  /** 允许查看属性的目录（stat / 列目录的元信息） */
  meta?: string[]
}

export interface ExecPermission {
  /** 可执行文件名（例如 `git`），按 PATH 查找 */
  bin: string
  /** 允许的参数白名单（正则）；省略表示不限参数 */
  args?: string[]
}

export interface NetPermissions {
  mode: 'none' | 'allowlist' | 'all'
  /** `mode: 'allowlist'` 时必填；域名精确匹配，不支持通配（`all` 里的 `*` 除外） */
  hosts?: string[]
  /** 允许的端口；省略表示不限 */
  ports?: number[]
  /** 是否允许明文 HTTP；默认只允许 HTTPS */
  allowPlainHttp?: boolean
  /** 是否允许访问内网 / 回环地址 */
  allowPrivate?: boolean
}

export interface OsPermissions {
  /** 用系统浏览器打开 http(s) 链接 */
  openExternal?: boolean
  /** 发系统通知 */
  notifications?: boolean
  /** 剪贴板：none / 只能写 / 可读可写 */
  clipboard?: 'none' | 'write' | 'read'
  /** 系统对话框：none / 只能打开 / 打开与保存 */
  dialogs?: 'none' | 'open' | 'save'
}

export interface PluginPermissions {
  trust: TrustLevel
  fs?: FsPermissions
  exec?: ExecPermission[]
  net?: NetPermissions
  os?: OsPermissions
  /** 密钥仓访问范围：不碰 / 只能用自己的命名空间 / 不限 */
  secrets?: 'none' | 'own' | 'all'
}

/** 缺省声明：与迁移前行为一致（完全信任） */
export const FULL_TRUST: PluginPermissions = Object.freeze({ trust: 'full' }) as PluginPermissions

/** 作用域里可以使用的路径变量 */
export const PATH_VARIABLES = ['project', 'userData', 'pluginDir', 'temp', 'home'] as const

export type PermissionVariableName = (typeof PATH_VARIABLES)[number]

export type PermissionVariables = Partial<Record<PermissionVariableName, string>>

/** 展开之后的作用域；`unresolved` 是变量缺失、没法展开的声明 */
export interface ResolvedPathScope {
  declared: string[]
  resolved: string[]
  unresolved: string[]
}

export interface ResolvedPermissions {
  trust: TrustLevel
  fs: {
    read: ResolvedPathScope
    write: ResolvedPathScope
    meta: ResolvedPathScope
  }
  exec: ExecPermission[]
  net: NetPermissions
  os: OsPermissions
  secrets: 'none' | 'own' | 'all'
  unresolved: string[]
}

const LEGACY_PERMISSIONS: ReadonlySet<string> = new Set<LegacyPermission>([
  'network',
  'secrets:own',
  'shell:openExternal',
  'dialog:open',
  'clipboard:write',
  'notifications:show'
])

export function isLegacyPermission(value: string): value is LegacyPermission {
  return LEGACY_PERMISSIONS.has(value)
}

const TRUST_LEVELS = new Set<string>(['full', 'sandboxed'])
const NET_MODES = new Set<string>(['none', 'allowlist', 'all'])
const CLIPBOARD = new Set<string>(['none', 'write', 'read'])
const DIALOGS = new Set<string>(['none', 'open', 'save'])
const SECRETS = new Set<string>(['none', 'own', 'all'])
const KNOWN_KEYS = new Set(['trust', 'fs', 'exec', 'net', 'os', 'secrets'])
const SCOPE_KEYS = new Set(['read', 'write', 'meta'])
const VARIABLE_PATTERN = /\$\{([A-Za-z0-9_.-]+)\}/g

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * 目录声明：绝对路径，或以 `${变量}` 开头；不允许 `..`，不允许段内通配。
 * 末尾的 `/**` 是允许的（表示整棵子树），校验前先剥掉。
 */
export function scopePathProblem(value: string): string | undefined {
  if (!value.trim()) return '路径不能为空'
  if (value.includes('\0')) return '路径不能包含 NUL 字节'

  const trimmed = value.replace(/[\\/]\*\*$/, '')
  if (/[*?]/.test(trimmed)) return '只支持目录，不支持段内通配（可以用末尾的 /**）'
  if (trimmed.split(/[\\/]+/).includes('..')) return '路径不能包含 ..'

  const absolute =
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith('\\\\') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('\\')
  if (!absolute && !trimmed.startsWith('${')) {
    return '必须是绝对路径，或以 ${project} / ${userData} 这类变量开头'
  }
  return undefined
}

function collectVariables(value: string): string[] {
  return [...value.matchAll(VARIABLE_PATTERN)]
    .map((match) => match[1])
    .filter((name): name is string => typeof name === 'string')
}

/** v1 数组 -> v2 对象；未知条目只警告，不阻断加载（老插件的宽容） */
export function normalizeLegacyPermissions(
  raw: readonly unknown[],
  warnings: string[] = [],
  context = 'permissions'
): PluginPermissions {
  const os: OsPermissions = {}
  let net: NetPermissions | undefined
  let secrets: PluginPermissions['secrets']

  for (const entry of raw) {
    if (typeof entry !== 'string') {
      warnings.push(`${context}：条目不是字符串，已忽略`)
      continue
    }
    if (!isLegacyPermission(entry)) {
      warnings.push(`${context}：未知的权限 "${entry}"，已忽略`)
      continue
    }
    switch (entry) {
      case 'network':
        net = { mode: 'all', allowPlainHttp: false, allowPrivate: true }
        break
      case 'secrets:own':
        secrets = 'own'
        break
      case 'shell:openExternal':
        os.openExternal = true
        break
      case 'dialog:open':
        os.dialogs = 'open'
        break
      case 'clipboard:write':
        os.clipboard = 'write'
        break
      case 'notifications:show':
        os.notifications = true
        break
    }
  }

  // v1 插件今天就跑在主进程里，降级会改变行为 —— 与 mics 一致，明确标成 full
  return {
    trust: 'full',
    ...(net ? { net } : {}),
    ...(Object.keys(os).length > 0 ? { os } : {}),
    ...(secrets ? { secrets } : {})
  }
}

function parseScope(
  raw: unknown,
  field: string,
  errors: string[],
  warnings: string[]
): string[] | undefined {
  if (raw === undefined) return undefined
  if (!isStringArray(raw)) {
    errors.push(`permissions.fs.${field} 必须是字符串数组`)
    return undefined
  }
  for (const value of raw) {
    const problem = scopePathProblem(value)
    if (problem) {
      errors.push(`permissions.fs.${field} 的 "${value}"：${problem}`)
      continue
    }
    for (const name of collectVariables(value)) {
      if (!(PATH_VARIABLES as readonly string[]).includes(name)) {
        warnings.push(`permissions.fs.${field} 使用了未知变量 \${${name}}，运行时不会被展开`)
      }
    }
  }
  return [...raw]
}

function parseExec(raw: unknown, errors: string[]): ExecPermission[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    errors.push('permissions.exec 必须是数组')
    return undefined
  }

  const rules: ExecPermission[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.bin !== 'string' || !item.bin.trim()) {
      errors.push('permissions.exec 条目需要非空的 bin')
      continue
    }
    if (item.args !== undefined && !isStringArray(item.args)) {
      errors.push(`permissions.exec 的 ${item.bin} 的 args 必须是字符串数组`)
      continue
    }

    let valid = true
    for (const pattern of item.args ?? []) {
      try {
        new RegExp(pattern)
      } catch {
        errors.push(`permissions.exec 的 ${item.bin} 的 args 里有非法正则：${pattern}`)
        valid = false
      }
    }
    if (!valid) continue

    rules.push({
      bin: item.bin,
      ...(item.args ? { args: [...item.args] } : {})
    })
  }
  return rules
}

function parseNet(raw: unknown, trust: TrustLevel, errors: string[]): NetPermissions | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) {
    errors.push('permissions.net 必须是对象')
    return undefined
  }
  if (typeof raw.mode !== 'string' || !NET_MODES.has(raw.mode)) {
    errors.push('permissions.net.mode 必须是 none / allowlist / all')
    return undefined
  }

  const mode = raw.mode as NetPermissions['mode']
  const hosts = raw.hosts
  if (hosts !== undefined && !isStringArray(hosts)) {
    errors.push('permissions.net.hosts 必须是字符串数组')
    return undefined
  }
  if (mode === 'allowlist' && (!hosts || hosts.length === 0)) {
    errors.push('permissions.net.mode = "allowlist" 时必须给出 hosts')
  }
  for (const host of hosts ?? []) {
    if (!host.trim()) errors.push('permissions.net.hosts 里有空白的域名')
    if (host.trim() === '*' && mode !== 'all') {
      errors.push('通配域名 "*" 只允许出现在 net.mode = "all" 里')
    }
  }
  if (mode === 'all' && trust !== 'full') {
    errors.push('net.mode = "all" 只允许与 trust = "full" 搭配')
  }

  if (raw.ports !== undefined) {
    if (!Array.isArray(raw.ports)) {
      errors.push('permissions.net.ports 必须是整数数组')
    } else {
      for (const port of raw.ports) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          errors.push(`permissions.net.ports 里的 ${String(port)} 不是合法端口`)
        }
      }
    }
  }
  for (const flag of ['allowPlainHttp', 'allowPrivate'] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') {
      errors.push(`permissions.net.${flag} 必须是布尔值`)
    }
  }

  return {
    mode,
    ...(hosts ? { hosts: [...hosts] } : {}),
    ...(Array.isArray(raw.ports) ? { ports: raw.ports as number[] } : {}),
    allowPlainHttp: raw.allowPlainHttp === true,
    allowPrivate: raw.allowPrivate === true
  }
}

function parseOs(raw: unknown, errors: string[]): OsPermissions | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) {
    errors.push('permissions.os 必须是对象')
    return undefined
  }
  for (const flag of ['openExternal', 'notifications'] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') {
      errors.push(`permissions.os.${flag} 必须是布尔值`)
    }
  }
  if (raw.clipboard !== undefined && !CLIPBOARD.has(String(raw.clipboard))) {
    errors.push('permissions.os.clipboard 必须是 none / write / read')
  }
  if (raw.dialogs !== undefined && !DIALOGS.has(String(raw.dialogs))) {
    errors.push('permissions.os.dialogs 必须是 none / open / save')
  }
  return {
    openExternal: raw.openExternal === true,
    notifications: raw.notifications === true,
    ...(raw.clipboard !== undefined
      ? { clipboard: raw.clipboard as OsPermissions['clipboard'] }
      : {}),
    ...(raw.dialogs !== undefined ? { dialogs: raw.dialogs as OsPermissions['dialogs'] } : {})
  }
}

export interface ParsePermissionsResult {
  permissions?: PluginPermissions
  errors: string[]
  warnings: string[]
}

/**
 * 校验并归一化 `permissions`。
 *
 * - 缺省 -> `{ trust: "full" }`（保持迁移前的行为）；
 * - 数组 -> v1 兼容；
 * - 对象 -> v2，未知字段报错（防拼写错误），未知变量只警告。
 *
 * 有 error 时**不返回** `permissions`：调用方应当整份拒绝这个 manifest，
 * 而不是把写错的声明降级成完全信任。
 */
export function parsePluginPermissions(
  raw: unknown,
  options: { context?: string; warnings?: string[] } = {}
): ParsePermissionsResult {
  const errors: string[] = []
  const warnings = options.warnings ?? []
  const context = options.context ?? 'permissions'

  if (raw === undefined) return { permissions: FULL_TRUST, errors, warnings }
  if (Array.isArray(raw)) {
    return { permissions: normalizeLegacyPermissions(raw, warnings, context), errors, warnings }
  }
  if (!isRecord(raw)) {
    errors.push(`${context} 必须是字符串数组或对象`)
    return { errors, warnings }
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) errors.push(`${context} 里有未知字段 "${key}"`)
  }

  const trustRaw = raw.trust ?? 'sandboxed'
  if (typeof trustRaw !== 'string' || !TRUST_LEVELS.has(trustRaw)) {
    errors.push(`${context}.trust 必须是 full / sandboxed`)
    return { errors, warnings }
  }
  const trust = trustRaw as TrustLevel

  let fs: FsPermissions | undefined
  if (raw.fs !== undefined) {
    if (!isRecord(raw.fs)) {
      errors.push(`${context}.fs 必须是对象`)
    } else {
      for (const key of Object.keys(raw.fs)) {
        if (!SCOPE_KEYS.has(key)) errors.push(`${context}.fs 里有未知字段 "${key}"`)
      }

      const read = parseScope(raw.fs.read, 'read', errors, warnings)
      const write = parseScope(raw.fs.write, 'write', errors, warnings)
      const meta = parseScope(raw.fs.meta, 'meta', errors, warnings)
      fs = {
        ...(read ? { read } : {}),
        ...(write ? { write } : {}),
        ...(meta ? { meta } : {})
      }
    }
  }

  let secrets: PluginPermissions['secrets']
  if (raw.secrets !== undefined) {
    if (typeof raw.secrets !== 'string' || !SECRETS.has(raw.secrets)) {
      errors.push(`${context}.secrets 必须是 none / own / all`)
    } else {
      secrets = raw.secrets as PluginPermissions['secrets']
    }
  }

  const exec = parseExec(raw.exec, errors)
  const net = parseNet(raw.net, trust, errors)
  const os = parseOs(raw.os, errors)

  if (errors.length > 0) return { errors, warnings }

  return {
    permissions: {
      trust,
      ...(fs ? { fs } : {}),
      ...(exec ? { exec } : {}),
      ...(net ? { net } : {}),
      ...(os ? { os } : {}),
      ...(secrets ? { secrets } : {})
    },
    errors,
    warnings
  }
}

/**
 * 展开路径变量。缺变量的声明留在 `unresolved` 里 —— 宿主不会拿一条展开不出来的
 * 作用域去放行（宁可拒绝，也不静默放开）。
 */
export function resolvePermissions(
  permissions: PluginPermissions | undefined,
  variables: PermissionVariables
): ResolvedPermissions {
  const unresolved = new Set<string>()

  const resolveScope = (declared: string[] | undefined): ResolvedPathScope => {
    const scope: ResolvedPathScope = { declared: [], resolved: [], unresolved: [] }
    for (const entry of declared ?? []) {
      scope.declared.push(entry)

      let failed = false
      const resolved = entry.replace(VARIABLE_PATTERN, (all: string, name: string) => {
        const value = variables[name as PermissionVariableName]
        if (!value) {
          failed = true
          return all
        }
        return value
      })
      if (failed) {
        scope.unresolved.push(entry)
        unresolved.add(entry)
        continue
      }
      const trimmed = resolved.replace(/[\\/]\*\*$/, '').replace(/[\\/]+$/, '')
      // 变量值可能带反斜杠，声明里又写了 `/`：统一成宿主平台的分隔符，
      // 免得界面和日志里出现 C:\a\b/data 这种混合形态
      scope.resolved.push(
        isWindowsPath(trimmed) ? trimmed.replace(/\//g, '\\') : trimmed.replace(/\\/g, '/')
      )
    }
    return scope
  }

  const permissions_ = permissions ?? FULL_TRUST
  const fs = permissions_.fs

  return {
    trust: permissions_.trust,
    fs: {
      read: resolveScope(fs?.read),
      write: resolveScope(fs?.write),
      meta: resolveScope(fs?.meta)
    },
    exec: permissions_.exec ?? [],
    net: permissions_.net ?? {
      mode: 'none',
      allowPlainHttp: false,
      allowPrivate: false
    },
    os: permissions_.os ?? {},
    secrets: permissions_.secrets ?? 'none',
    unresolved: [...unresolved]
  }
}

/** 把 v1 的能力字符串翻译成 v2 声明上的判断（调用方仍用老字符串） */
export function allowsLegacy(permissions: PluginPermissions | undefined, legacy: string): boolean {
  const os = permissions?.os
  switch (legacy) {
    case 'network':
      return permissions?.net !== undefined && permissions.net.mode !== 'none'
    case 'secrets:own':
      return permissions?.secrets === 'own' || permissions?.secrets === 'all'
    case 'shell:openExternal':
      return os?.openExternal === true
    case 'dialog:open':
      return os?.dialogs === 'open' || os?.dialogs === 'save'
    case 'clipboard:write':
      return os?.clipboard === 'write' || os?.clipboard === 'read'
    case 'notifications:show':
      return os?.notifications === true
    default:
      return false
  }
}

/** 路径是否在某个作用域列表里；`windows` 由调用方决定（测试要能两边都跑） */
export function isPathWithinScopes(
  scopes: readonly string[],
  target: string,
  windows = isWindowsPath(target)
): boolean {
  const normalizedTarget = normalizeAbsolutePath(target, windows)
  if (normalizedTarget === null) return false

  return scopes.some((scope) => {
    const normalizedScope = normalizeAbsolutePath(scope, windows)
    if (normalizedScope === null) return false
    if (normalizedTarget === normalizedScope) return true
    // 前缀必须落在分隔符上，避免 /a/bc 命中 /a/b
    return normalizedTarget.startsWith(`${normalizedScope}/`)
  })
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/**
 * 归一化一个绝对路径：统一分隔符、折叠 `.` 与 `..`、去掉末尾分隔符。
 *
 * 非法路径（相对路径、越过根、含 NUL）返回 `null` —— 调用方据此拒绝。
 * Windows 下大小写不敏感，统一小写，和宿主自己的路径比较规则一致。
 */
export function normalizeAbsolutePath(
  value: string,
  windows = isWindowsPath(value)
): string | null {
  if (!value || value.includes('\0')) return null

  let text = value.replace(/\\/g, '/')
  let prefix: string

  if (/^[A-Za-z]:\//.test(text)) {
    prefix = text.slice(0, 2)
    text = text.slice(2)
  } else if (text.startsWith('//')) {
    // UNC：\\server\share -> //server/share
    prefix = '//'
    text = text.slice(2)
  } else if (text.startsWith('/')) {
    prefix = ''
  } else {
    return null
  }

  const segments: string[] = []
  for (const segment of text.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }

  const body = segments.join('/')
  let normalized = prefix === '//' ? `//${body}` : prefix ? `${prefix}/${body}` : `/${body}`
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '')
  return windows ? normalized.toLowerCase() : normalized
}
