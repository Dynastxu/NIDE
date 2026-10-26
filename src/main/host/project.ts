import type { ProjectListItem, ProjectOpenResult, ProjectRecord } from '@shared/project'
import { invokeHost } from './process'

/**
 * shell 侧的「打开过的项目」客户端。
 *
 * `projects.json` 的唯一实现在 host（[project-store.ts](../../packages/host/src/services/project-store.ts)）：
 * 读列表、打开、移除、关闭都走这里。shell 不落盘，也不持有第二份「当前项目」——
 * 它只保留**窗口绑定的那个项目路径**（建窗时经 `additionalArguments` 固定，见 window.ts）。
 *
 * 这一层很薄，存在的理由是：把 `invokeHost('project', ...)` 的方法名与返回类型收在
 * 一处，调用方（project.ipc.ts / window.ts）不必各自重复一遍断言，改协议时也只有
 * 一个地方要跟着改。
 *
 * 失败一律抛出，不静默降级：这些调用要么是状态变更，要么是界面赖以决定「现在开着
 * 哪个项目」的数据。吞掉失败会让 shell 与 host 对这件事的看法悄悄分叉 —— 那种分歧
 * 只在换窗口、存档、写文件时才暴露出来，查起来要命。
 */

/** 「打开过的项目」列表，最近打开的在前 */
export function listProjects(): Promise<ProjectListItem[]> {
  return invokeHost<ProjectListItem[]>('project', 'list')
}

/** 启动时该默认打开哪个项目。它同时把 host 的「当前项目」定下来 */
export function startupProject(): Promise<ProjectRecord | null> {
  return invokeHost<ProjectRecord | null>('project', 'startup')
}

/**
 * 打开一个目录作为当前项目：记进列表、落盘、记为当前。
 *
 * 目录不存在 / 不是目录时**不抛**，回一条带原因的结果（见 ProjectOpenResult）；
 * 只有 host 本身不可达才抛。
 */
export function openProject(dirPath: string): Promise<ProjectOpenResult> {
  return invokeHost<ProjectOpenResult>('project', 'open', [dirPath])
}

/** 从列表里移除一条记录，返回移除后的列表。磁盘上的目录不动 */
export function forgetProject(dirPath: string): Promise<ProjectListItem[]> {
  return invokeHost<ProjectListItem[]>('project', 'forget', [dirPath])
}

/** 关闭当前项目：这一次会话回到「没有项目」，列表与 lastOpened 都不动 */
export async function closeProject(): Promise<void> {
  await invokeHost('project', 'close')
}
