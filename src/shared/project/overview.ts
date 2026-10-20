import type { ProjectConfig } from './config'
import type { DirReadFailureReason } from './files'

/**
 * 概述的契约：内容目录（`.nide/config.yml` 的 `overview.path`）里是**一堆普通
 * Markdown**，其中最多两份**可以**被标记成「大纲」与「写作风格」。
 *
 * ```
 * overview/
 *   大纲.md        <- config.yml: overview.outline
 *   文风.md        <- config.yml: overview.style
 *   世界观.md       <- 普通文件，没有任何标记
 *   人物小传.md     <- 普通文件，没有任何标记
 * ```
 *
 * 四条刻意的选择：
 *
 * 1. **所有文件都是普通 Markdown**。标记不改变文件、不复制文件、不建目录；它只回答
 *    「取大纲 / 写作风格时该读哪个文件」。
 * 2. **标记是可选的**。没标记时 `.nide/config.yml` 的概述段只有 `path`；标记之后才
 *    多出 `outline` / `style` 两个键（见 ./config 的 OverviewSection）。
 * 3. **用户可以加任意多普通文件**，它们不进配置、不参与角色判断；列表按目录里的文件
 *    直接展示。
 * 4. **标记的是文件名，不是绝对路径**。概述目录由配置里的 `path` 决定，而 `.nide`
 *    要跟项目一起进版本库，绝对路径换台机器就指向别处。
 *
 * 这一层不放 `config.yml` 的解析与序列化：那是项目配置的职责。这里只有**列表的载荷
 * 形状**与**改标记的请求 / 结果**。
 */

/** 一个文件可以被标记成的两个角色 */
export const OVERVIEW_ROLES = ['outline', 'style'] as const

export type OverviewRole = (typeof OVERVIEW_ROLES)[number]

// ============ 概述列表（IPC 的载荷形状） ============

/** 概述目录里的一份 Markdown 文档 */
export interface OverviewDocument {
  /** 绝对路径 */
  path: string
  /** 显示名（文件名） */
  name: string
}

/**
 * 读概述列表的结果：目录里**实际存在的** Markdown。
 *
 * 「哪份是大纲 / 写作风格」由调用方对照项目配置算（配置是唯一的真相）。这样读盘这一层
 * 不必猜角色，配置改了也不需要多一条读盘路径。
 */
export type OverviewListResult =
  | { ok: true; path: string; documents: OverviewDocument[] }
  | { ok: false; reason: DirReadFailureReason }

// ============ 改标记 ============

/**
 * 「把某份 Markdown 标记成大纲 / 写作风格」的请求。
 *
 * 没有路径参数：概述目录由主进程从项目配置里取，渲染进程只声明「哪个角色、哪个文件」。
 */
export interface OverviewRoleUpdateRequest {
  /** 标记成哪一个角色 */
  role: OverviewRole
  /** 概述目录里的文件名（单段，必须是 Markdown） */
  fileName: string
}

/**
 * 改标记的结果。
 *
 * `unknown-file` 单列：用户点的是列表里的一项，走到主进程时它已经不在了 —— 界面要说
 * 的是「这份文档不在了」，而不是笼统的「出错了」。
 */
export type OverviewRoleUpdateResult =
  | { ok: true; config: ProjectConfig }
  | { ok: false; reason: 'invalid-name' | 'unknown-file' | 'unreadable' }

// ============ IPC ============

/**
 * 概述的 IPC 通道名。
 *
 * 和其它通道一样集中在这里：拼错通道名没有编译错误，只会在运行时静默失效。
 */
export const PROJECT_OVERVIEW_CHANNELS = {
  /** 读概述目录里的 Markdown（invoke），参数是概述内容目录的绝对路径 */
  readOverview: 'host:project-read-overview',
  /** 把概述目录里的某份 Markdown 标记成大纲 / 写作风格（invoke），改的是项目配置 */
  setRole: 'host:project-set-overview-role'
} as const
