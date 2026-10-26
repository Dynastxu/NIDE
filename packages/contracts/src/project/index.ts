/**
 * 项目契约：打开过的文件夹、当前项目、以及跨进程的 IPC 通道名。
 *
 * 这一层被主进程、preload、渲染进程、host 进程共用，所以**不能** import
 * electron / fs / DOM。目录内的模块之间一律用 `#project/*`（见 package.json 的
 * `imports`）：`@nide/contracts/*` 是构建期别名、免扩展名的相对路径 Node 也不认，只有这一层
 * 是 Node / tsc / Vite 三边都解析得了的，host（纯 Node ESM）才能直接 import。
 *
 * 文件树（目录条目、排序、支持哪些文本格式、新建时的名字校验）在 `#project/files`，
 * 同样只放纯逻辑；项目级配置（`.nide/config.yml` 的形状与文本读写）在 `./config`；
 * 章节 Markdown 的开头属性（frontmatter）在 `./chapters`，伏笔（固定四个字段的整份
 * yml）在 `./foreshadowing`，图鉴（分区的字段表与条目）在 `./gallery`，概述（平铺的
 * Markdown，其中两份被配置登记成大纲 / 写作风格）在 `./overview`；它们共用
 * `./frontmatter` 里那一份「属性块怎么读」。
 */

import { projectPathKey } from '#project/store'
import type { ProjectRecord } from '#project/store'

export * from '#project/store'
export * from '#project/files'
export * from '#project/tree'
export * from '#project/config'
export * from '#project/frontmatter'
export * from '#project/chapters'
export * from '#project/foreshadowing'
export * from '#project/gallery'
export * from '#project/overview'

/**
 * 启动参数前缀：主进程建窗时把**当前项目路径**喂进渲染进程。
 *
 * 和 locale / 窗口种类 / 日志级别一样走启动参数而不是 IPC：标题栏第一帧就要显示
 * 项目名，异步取会先渲染一版没有项目名的标题再跳一下。
 */
export const PROJECT_ARG_PREFIX = '--nide-project='

/**
 * 这次「打开」会不会丢掉一个已经打开的项目。
 *
 * 换项目会把主窗口原地重建（项目路径是建窗时经 `additionalArguments` 固定的），
 * 当前窗口的一切跟着归零 —— 所以要拿它来决定**要不要先问一句**。判据只有两条：
 *
 * - 现在没有打开的项目（从欢迎窗口打开）：没有东西可丢，不问；
 * - 要打开的就是当前这个项目（重复打开 / 只是点了一下自己）：什么都没发生，不问。
 *
 * 是否忽略大小写与 `projectPathKey` 同一条约定：由调用方按平台语义给。
 */
export function isProjectSwitch(
  currentPath: string | null | undefined,
  nextPath: string,
  caseInsensitive: boolean
): boolean {
  if (!currentPath) return false
  return projectPathKey(currentPath, caseInsensitive) !== projectPathKey(nextPath, caseInsensitive)
}

/** 打开项目的结果。失败带着原因，界面据此给不同的说法 */
export type ProjectFailureReason =
  /** 用户在对话框里取消了 —— 这不是错误，界面不该弹任何东西 */
  | 'cancelled'
  /** 目录不存在 */
  | 'missing'
  /** 路径存在，但不是目录 */
  | 'not-a-directory'
  /**
   * 宿主没给出结论（host 不可达 / 超时）。
   *
   * 单列一条而不是并到 `missing`：这两件事对用户的含义完全不同 —— 一个是「这个文件夹
   * 没了，去别处找」，一个是「宿主进程出问题了」。混在一句「目录不存在」里，用户会
   * 把时间花在错误的方向上。
   */
  | 'unreadable'

export type ProjectOpenResult =
  { ok: true; project: ProjectRecord } | { ok: false; reason: ProjectFailureReason; path?: string }

/** 目录对话框的两种用途：新建项目 / 打开已有目录 */
export type ProjectPickMode = 'new' | 'open'

/**
 * IPC 通道名。
 *
 * 和 WINDOW_CHANNELS 同理集中在这里：拼错通道名没有编译错误，只会在运行时静默失效。
 */
export const PROJECT_CHANNELS = {
  /** 取「打开过的项目」列表（invoke） */
  list: 'host:project-list',
  /** 按路径打开一个已有记录（invoke）。参数：路径 + ConfirmOptions */
  open: 'host:project-open',
  /** 弹系统目录对话框并打开所选目录（invoke）。参数：ProjectPickMode + ConfirmOptions */
  pick: 'host:project-pick',
  /** 从列表里移除一条记录（invoke），返回移除后的列表 */
  remove: 'host:project-remove',
  /**
   * 关闭当前项目并回退到欢迎窗口（单向 send，参数 ConfirmOptions）。
   *
   * **不删记录**：这一次会话不再用这个项目，但它仍然是「打开过的项目」，也仍然是
   * 下次启动时要打开的那一个。
   *
   * 单向而不是 invoke：确认之后这个窗口马上就会被拆掉，回执没有接收方。
   */
  close: 'host:project-close'
} as const
