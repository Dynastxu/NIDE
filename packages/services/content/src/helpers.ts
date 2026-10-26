/**
 * 内容服务共用的请求校验与路径解析（从 host 入口原样搬出）。
 *
 * 唯一的改动：`allowedRoots()` 从「自己去问当前项目」变成接收 `root` 参数 ——
 * 服务不该在模块级缓存项目状态，否则切换项目时要通知它。
 */
import process from 'node:process'
import {
  filePathKey,
  type CreateEntryRequest,
  type DeleteEntryRequest,
  type GalleryCreateRequest,
  type OverviewRoleUpdateRequest,
  type ProjectConfig,
  type RenameEntryRequest
} from '../../../contracts/src/project/index.ts'
import { loadProjectConfig, resolveConfigDirectory } from '../../config/src/project-config.ts'

/** 文件读写的允许根：MVP 只有当前项目一个。 */
export function allowedRoots(root: string | undefined): string[] {
  return root ? [root] : []
}

export function caseInsensitivePaths(): boolean {
  return process.platform === 'win32'
}

/**
 * 请求形状校验：host 收到的是渲染进程经 MessagePort 发来的 JSON，形状完全不可信。
 * 名字的合法性仍由 service 用 `validateEntryName` 判，这一层只确认类型。
 */
export function parseCreateEntryRequest(value: unknown): CreateEntryRequest | null {
  if (!value || typeof value !== 'object') return null

  const { kind, targetPath, name, content } = value as Partial<CreateEntryRequest>
  if (kind !== 'file' && kind !== 'directory') return null
  if (typeof targetPath !== 'string' || targetPath.length === 0) return null
  if (typeof name !== 'string') return null
  // 初始内容可以不给；给了就必须是字符串（null / 数字不能被悄悄写成 "null" / "42"）
  if (content !== undefined && typeof content !== 'string') return null

  return { kind, targetPath, name, ...(content === undefined ? {} : { content }) }
}

export function parseRenameEntryRequest(value: unknown): RenameEntryRequest | null {
  if (!value || typeof value !== 'object') return null

  const { targetPath, name } = value as Partial<RenameEntryRequest>
  if (typeof targetPath !== 'string' || targetPath.length === 0) return null
  if (typeof name !== 'string') return null

  return { targetPath, name }
}

export function parseDeleteEntryRequest(value: unknown): DeleteEntryRequest | null {
  if (!value || typeof value !== 'object') return null

  const { targetPath } = value as Partial<DeleteEntryRequest>
  if (typeof targetPath !== 'string' || targetPath.length === 0) return null

  return { targetPath }
}

/** 图鉴 / 概述通道的请求形状校验（与主进程的 parse* 一一对应） */
export function parseGalleryCreateRequest(value: unknown): GalleryCreateRequest | null {
  if (!value || typeof value !== 'object') return null

  const { targetPath, name } = value as Partial<GalleryCreateRequest>
  if (typeof targetPath !== 'string' || targetPath.length === 0) return null
  if (typeof name !== 'string') return null

  return { targetPath, name }
}

export function parseGalleryRegistryRequest(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null

  const { characters } = value as { characters?: unknown }
  if (typeof characters !== 'string' || characters.length === 0) return null

  return characters
}

export function parseOverviewRoleRequest(value: unknown): OverviewRoleUpdateRequest | null {
  if (!value || typeof value !== 'object') return null

  const { role, fileName } = value as Partial<OverviewRoleUpdateRequest>
  if (role !== 'outline' && role !== 'style') return null
  if (typeof fileName !== 'string' || fileName.length === 0) return null

  return { role, fileName }
}

/**
 * 配置里那个图鉴内容目录的绝对路径；读不到配置时给 null。
 *
 * 图鉴的三个通道都要它：渲染进程报上来的路径必须**正是**这一个，否则拒绝 —— 不判的
 * 话，「读图鉴」就成了一条枚举项目里任意一层子目录的通道。
 */
export async function resolveGalleryRoot(root: string): Promise<string | null> {
  try {
    const config = await loadProjectConfig(root)
    return resolveConfigDirectory(root, config.gallery.path)
  } catch (error) {
    console.warn('[nide-host] failed to resolve the gallery directory', { error })
    return null
  }
}

/** 当前项目的概述配置与内容目录绝对路径；读不到配置时给 null */
export async function resolveOverviewContext(
  root: string
): Promise<{ config: ProjectConfig; path: string } | null> {
  try {
    const config = await loadProjectConfig(root)
    return { config, path: resolveConfigDirectory(root, config.overview.path) }
  } catch (error) {
    console.warn('[nide-host] failed to resolve the overview directory', { error })
    return null
  }
}

/** 两个路径是不是同一个位置。大小写按平台语义折叠（与范围校验同一条约定） */
export function samePath(left: string, right: string): boolean {
  if (right.length === 0) return false

  const caseInsensitive = caseInsensitivePaths()
  return filePathKey(left, caseInsensitive) === filePathKey(right, caseInsensitive)
}
