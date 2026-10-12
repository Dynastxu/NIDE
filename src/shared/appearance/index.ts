import { DEFAULT_THEME } from '@shared/theme'
import type { ThemeId } from '@shared/theme'

/**
 * 外观偏好：**用户选了哪套主题**。
 *
 * 这一层只剩"选择"这件事，配色在样式表里 —— 就像语言偏好只记"选了哪个 locale"，
 * 词条数据归语言包。分开的好处是主题可以增加、可以换实现，而偏好文件里那个值
 * 只是一个 id。
 *
 * 它被主进程、preload、渲染进程共用，所以**不能** import electron / DOM。
 */

export interface AppearancePreference {
  /** 选中的主题 id。不存在时由主题注册表回落到默认主题并报 fallbackFrom */
  theme: ThemeId
  /**
   * 主题是否跟随操作系统的深浅色。
   *
   * **当前恒为 false**：设置页把这一项摆成了灰的（机制已经齐了，缺的是把系统切换
   * 时的表现逐套主题调稳）。字段留着是为了打开它时不必动偏好文件格式 ——
   * 落盘形状一改，老用户的设置就得迁移。
   */
  followSystem: boolean
}

export const DEFAULT_APPEARANCE: AppearancePreference = {
  theme: DEFAULT_THEME,
  followSystem: false
}

/**
 * 把任意来源（磁盘上的 JSON、IPC 载荷）收成一份合法的偏好。
 *
 * 主题 id 本身不做白名单校验：合法性由主题注册表回答（找不到就是找不到，会走
 * fallbackFrom 那条既有路径）。这里只保证形状对 —— 一个非字符串的 theme 会让
 * 下游的查表逻辑拿到 undefined，那就不是在排查主题了。
 */
export function normalizeAppearancePreference(value: unknown): AppearancePreference {
  if (!value || typeof value !== 'object') return { ...DEFAULT_APPEARANCE }

  const raw = value as { theme?: unknown; followSystem?: unknown }
  return {
    theme: typeof raw.theme === 'string' && raw.theme.length > 0 ? raw.theme : DEFAULT_THEME,
    // 只有真正的布尔量才算勾选：字符串 "false" 是勾上的，容易看反
    followSystem:
      typeof raw.followSystem === 'boolean' ? raw.followSystem : DEFAULT_APPEARANCE.followSystem
  }
}

/**
 * 启动参数前缀：主进程把**完整偏好**喂进渲染进程。
 *
 * 为什么偏好要同步喂，而不是靠主进程广播（APPEARANCE_CHANNEL）：
 * `pushEventToRenderer` 只发给**此刻已经存在**的窗口。启动阶段窗口是一个一个建的，
 * 先建好的那个发不出广播，后建的也收不到 —— 设置页于是会显示一份"主题对了、但
 * 跟随系统没勾"的错状态，而这恰恰是用户唯一能看见这一页的地方。
 *
 * 同步喂进来就没有这个时序问题：任何窗口在首帧就拿到权威偏好。
 */
export const APPEARANCE_ARG_PREFIX = '--nide-appearance='

/**
 * 把偏好编码成启动参数的值。
 *
 * 用 `<theme>:<followSystem>` 这种极简格式而不是 JSON，理由和启动参数本身一样：
 * 它只经过 argv 一次、不参与任何持久化，越简单越不容易被引号或转义咬到。主题 id
 * 里的冒号会被自然丢掉（id 约定用点号分隔），解析失败则整条回落到默认偏好。
 */
export function encodeAppearancePreference(preference: AppearancePreference): string {
  return `${preference.theme}:${preference.followSystem ? '1' : '0'}`
}

/**
 * 启动参数前缀：主进程把**当前配色是深是浅**喂进渲染进程。
 *
 * 为什么深浅也要同步喂，而不是等异步 IPC：渲染进程要在**首帧之前**决定根元素挂不挂
 * `.theme-light`，晚一步就会先按深色画一帧（选浅色时表现为整屏闪一下深色）。
 * 首帧之前能用的只有启动参数。
 */
export const THEME_PALETTE_ARG_PREFIX = '--nide-theme-palette='

/**
 * 主题偏好变化的**频道名**（主进程 -> 渲染进程）。
 *
 * 首帧那份偏好走启动参数（见 APPEARANCE_ARG_PREFIX），这条通道只负责**启动之后**
 * 的变化：用户在设置里提交了、系统外观变了（跟随系统时）、或别的窗口改了。
 *
 * 注意它**不是**一条独立的 Electron 事件名，而是 `host:event` 那条既有总线上的一
 * 个频道（见 main/ipc 的 pushEventToRenderer）：主进程 `send('host:event', 频道名, 载荷)`，
 * preload 收下来之后按这个字符串过滤。所以传的是**载荷**，不是偏好 —— 偏好里的
 * "跟随系统"目前恒为 false，界面读本地那份就够。
 *
 * 是否需要它由窗口模型决定：设置窗口和主窗口是两个渲染进程、两份 store，
 * 在设置里换主题，主窗口那边不会自己变 —— 必须有人推它一把。
 */
export const APPEARANCE_CHANNEL = 'host:appearance-changed'
