import type { ThemeId } from '../theme/types.js'

/**
 * 外观偏好：**用户选了哪套主题**。
 *
 * 这一层只剩"选择"这件事，配色在样式表里 —— 就像语言偏好只记"选了哪个 locale"，
 * 词条数据归语言包。分开的好处是主题可以增加、可以换实现，而偏好文件里那个值
 * 只是一个 id。
 *
 * 它被主进程、preload、渲染进程、**host** 共用，所以既不能 import electron / DOM，
 * 也不能有运行时 import（host 是纯 Node ESM，只能加载自包含文件）。`DEFAULT_THEME`
 * 因此写成字面量，并由 `test/shared/theme/theme-data.test.ts` 钉住「必须等于
 * theme/builtin.ts 的 DEFAULT_THEME」。
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

/** 没有偏好、或文件坏掉时的地板（`theme` 必须与 theme/builtin 的 DEFAULT_THEME 一致） */
export const DEFAULT_APPEARANCE: AppearancePreference = {
  theme: 'builtin.dark',
  followSystem: false
}

/** 主题的「当前状态」：渲染进程要的载荷 + 用户选的那份偏好 */
export interface AppearanceState {
  payload: import('../theme/types.js').ThemePayload
  preference: AppearancePreference
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
    theme:
      typeof raw.theme === 'string' && raw.theme.length > 0 ? raw.theme : DEFAULT_APPEARANCE.theme,
    // 只有真正的布尔量才算勾选：字符串 "false" 是勾上的，容易看反
    followSystem:
      typeof raw.followSystem === 'boolean' ? raw.followSystem : DEFAULT_APPEARANCE.followSystem
  }
}
