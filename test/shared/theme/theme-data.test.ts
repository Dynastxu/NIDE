import { describe, expect, it } from 'vitest'
import { DEFAULT_APPEARANCE, normalizeAppearancePreference } from '@shared/appearance'
import {
  BUILTIN_THEMES,
  DEFAULT_THEME,
  THEME_WINDOW_COLORS,
  findBuiltinTheme,
  paletteOf
} from '@shared/theme'

/**
 * 主题数据的一致性。
 *
 * `DEFAULT_APPEARANCE.theme` 在 `shared/appearance/preference.ts` 里写成了字面量
 * （那个文件必须能被 host 的纯 Node ESM 加载，所以不能 import 主题模块的运行时值）。
 * 代价是「同一个默认主题写了两遍」，这里把它钉住：两边一旦漂移，这条用例先红。
 */
describe('主题数据', () => {
  it('默认外观的主题与 DEFAULT_THEME 必须一致', () => {
    expect(DEFAULT_APPEARANCE.theme).toBe(DEFAULT_THEME)
  })

  it('默认主题是深色，并且窗口底色覆盖两种配色', () => {
    expect(paletteOf(DEFAULT_THEME)).toBe('dark')
    expect(THEME_WINDOW_COLORS.dark).toMatch(/^#[0-9a-f]{6}$/i)
    expect(THEME_WINDOW_COLORS.light).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('认不出来的主题按深色算，查表给 null', () => {
    expect(findBuiltinTheme('nope')).toBeNull()
    expect(paletteOf('nope')).toBe('dark')
  })

  it('可选主题的 id 不重复', () => {
    const ids = BUILTIN_THEMES.map((theme) => theme.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('偏好归一化：只认真布尔与字符串 id', () => {
    expect(normalizeAppearancePreference({ theme: 'builtin.light', followSystem: true })).toEqual({
      theme: 'builtin.light',
      followSystem: true
    })
    expect(normalizeAppearancePreference({ theme: 42, followSystem: 'false' })).toEqual({
      theme: DEFAULT_APPEARANCE.theme,
      followSystem: false
    })
    expect(normalizeAppearancePreference(null)).toEqual(DEFAULT_APPEARANCE)
  })
})
