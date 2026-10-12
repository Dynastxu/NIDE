import { nativeTheme } from 'electron'
import { DEFAULT_APPEARANCE } from '@shared/appearance'
import { BUILTIN_THEMES, DEFAULT_THEME, THEME_WINDOW_COLORS, findBuiltinTheme } from '@shared/theme'
import { loggerFor } from '../logger'
import { readPreferredAppearance, writePreferredAppearance } from './preference'
import type { AppearancePreference } from '@shared/appearance'
import type { ThemeId, ThemePalette, ThemePayload } from '@shared/theme'

const logger = loggerFor('appearance')

/**
 * 主题的运行时状态。主进程是**唯一的真相来源**：
 *
 * - `currentPreference` 是用户选的那份（落盘，见 preference.ts）；
 * - 「现在实际用哪套」由偏好 + 内置主题表算出来（`resolveCurrent()`），
 *   各窗口不自己算 —— 它们只拿结论。
 *
 * 主进程需要知道的只有**深浅**：它决定 `nativeTheme.themeSource`（原生对话框、
 * 日期选择器、滚动条）与窗口底色。具体颜色由两套样式表负责，不经过这里。
 */
let currentPreference: AppearancePreference = { ...DEFAULT_APPEARANCE }

/** 最近一次广播出去的主题 id。只用来判断「有没有真的变」，避免重复推送 */
let lastBroadcastTheme: ThemeId | null = null

/**
 * 广播出口由装配处注入（见 main/index.ts）。
 *
 * 不让本模块直接 import host.ipc 的 pushEventToRenderer：那会让
 * appearance -> ipc -> appearance 绕成一个环。注入用的是既有的
 * 「调用方把能力交进来」写法（同 main/index.ts 的 registerWindowActions）。
 */
let broadcast: ((payload: ThemePayload) => void) | null = null

export function registerAppearanceBroadcast(send: (payload: ThemePayload) => void): void {
  broadcast = send
}

export function getAppearancePreference(): AppearancePreference {
  return { ...currentPreference }
}

/**
 * 算出当前要用的主题。
 *
 * `fallbackFrom` 会一路传到渲染进程：用户选的 id 认不出来时（偏好文件被手改、
 * 或那套主题已经不存在）必须**说出来**，否则界面只是"自己变回深色了"，没人知道为什么。
 */
function resolveCurrent(): { theme: ThemeId; palette: ThemePalette; fallbackFrom?: ThemeId } {
  const found = findBuiltinTheme(currentPreference.theme)
  if (found) return { theme: found.id, palette: found.palette }

  return {
    theme: DEFAULT_THEME,
    palette: findBuiltinTheme(DEFAULT_THEME)?.palette ?? 'dark',
    fallbackFrom: currentPreference.theme
  }
}

/** 渲染进程要的那份载荷：可选哪些、现在用哪个、那个是深是浅 */
export function getThemePayload(): ThemePayload {
  const resolved = resolveCurrent()

  return {
    // fallbackFrom 有值时，theme 是**回落后实际生效**的那个
    theme: resolved.theme,
    palette: resolved.palette,
    available: [...BUILTIN_THEMES],
    ...(resolved.fallbackFrom ? { fallbackFrom: resolved.fallbackFrom } : {})
  }
}

/**
 * 当前配色的深浅。建窗时的窗口底色用它 —— 这是本模块**必须**在主进程侧存在的
 * 原因：窗口底色要在页面渲染之前定下来，渲染进程那时还没有机会说话。
 */
export function getCurrentPalette(): ThemePalette {
  return resolveCurrent().palette
}

/**
 * 窗口底色。与样式表里那种配色的页面底色一致
 * （见 shared/theme 的 THEME_WINDOW_COLORS）。
 */
export function getCurrentWindowColor(): string {
  return THEME_WINDOW_COLORS[getCurrentPalette()]
}

/**
 * 初始化：读盘 -> 校验偏好里的主题是否存在 -> 设 nativeTheme。
 *
 * 必须在**开窗之前**调用：窗口底色与启动参数都依赖它。
 */
export function initAppearance(): void {
  currentPreference = readPreferredAppearance()

  // 偏好里的主题认不出来时显式回落一次，让日志留下痕迹；界面那边由 fallbackFrom 提示
  if (!findBuiltinTheme(currentPreference.theme)) {
    logger.warn('Preferred theme is not available, falling back', {
      requested: currentPreference.theme,
      fallback: DEFAULT_THEME
    })
    currentPreference = { ...currentPreference, theme: DEFAULT_THEME }
  }

  applyNativePalette()

  /**
   * 系统外观变化时，或 `themeSource` 被改动之后，Electron 会触发 updated。
   * 这一条覆盖了「跟随系统」那一路（当前是灰的，但机制留着）。判重是必要的：
   * updated 也会因为高对比度等无关开关而触发，那时主题没变，没有窗口需要被叫醒。
   */
  nativeTheme.on('updated', () => {
    pushCurrent('system appearance changed')
  })

  // 首帧的启动参数已经带上了主题，所以这里不做首轮广播：那时还没有窗口
  lastBroadcastTheme = resolveCurrent().theme

  logger.info('Theme resolved', {
    theme: lastBroadcastTheme,
    palette: getCurrentPalette(),
    available: BUILTIN_THEMES.map((theme) => theme.id)
  })
}

/**
 * 提交一套新主题。
 *
 * 刻意**不做窗口重建**：换主题不像换语言那样需要重建（词条表在首帧前就固定了），
 * 它只是给根元素换一个类名加一个原生明暗，各窗口收到广播后自己换掉即可 —— 因此
 * 也不会丢掉编辑器里未保存的内容，不需要任何二次确认。
 *
 * 返回 false 表示这个主题不存在，什么都没改（对应 switchLocale 的同名语义）。
 */
export function setThemePreference(theme: ThemeId, followSystem: boolean): boolean {
  if (!findBuiltinTheme(theme)) {
    logger.error('Refusing to switch to a theme that is not available', { theme })
    return false
  }

  currentPreference = { theme, followSystem }
  writePreferredAppearance(currentPreference)
  applyNativePalette()

  logger.info('Theme preference updated', { theme, followSystem })

  // 偏好一定变了，所以强制推一次：即便解析出来的主题与之前相同（比如重复提交同一套），
  // 设置页的控件也要跟着更新（见 pushCurrent 的 force）
  pushCurrent('preference updated', true)
  return true
}

/** 把当前配色的深浅落到 Electron 的原生部分上 */
function applyNativePalette(): void {
  /**
   * 「跟随系统」暂时恒为 false（设置页把这一项摆成了灰的），但这条分支留着：
   * 机制是现成的，缺的只是把系统切换时的表现逐套主题调稳。
   */
  nativeTheme.themeSource = currentPreference.followSystem ? 'system' : getCurrentPalette()
}

/**
 * 把「当前主题的完整载荷」推给所有窗口。
 *
 * `force` 用于偏好变了、但解析出来的主题没变的情形（例如重复提交同一套主题）：
 * 窗口不需要重绘，但设置页的控件要跟着变，所以仍然得推一次。
 */
function pushCurrent(reason: string, force = false): void {
  const payload = getThemePayload()
  if (!force && payload.theme === lastBroadcastTheme) return

  lastBroadcastTheme = payload.theme
  logger.debug('Theme broadcast', { reason, theme: payload.theme, palette: payload.palette })
  broadcast?.(payload)
}
