import { nativeTheme } from 'electron'
import { DEFAULT_APPEARANCE } from '@shared/appearance'
import { BUILTIN_THEMES, DEFAULT_THEME, THEME_WINDOW_COLORS } from '@shared/theme'
import { invokeHost } from '../host/process'
import { loggerFor } from '../logger'
import type { AppearancePreference, AppearanceState } from '@shared/appearance'
import type { ThemeId, ThemePalette, ThemePayload } from '@shared/theme'

const logger = loggerFor('appearance')

/**
 * shell 侧的**外观缓存**。
 *
 * 主题状态与偏好文件都在 host（[appearance.ts](../../packages/host/src/services/appearance.ts)）：
 * 它是业务状态，和插件 / 配置住在一起。这里保留一份是因为**开窗要同步取值** ——
 * 窗口底色（`backgroundColor`）与启动参数（`--nide-appearance=` /
 * `--nide-theme-palette=`）都在建窗那一刻定死，那一步跑不了 IPC。
 *
 * `nativeTheme` 的原生部分由 host 通过反向桥设置；这里只监听系统变化并重拉一次。
 */

/** host 还没回话（或起不来）时的地板：深色，和样式表的默认一致 */
let current: AppearanceState = {
  payload: { theme: DEFAULT_THEME, palette: 'dark', available: [...BUILTIN_THEMES] },
  preference: { ...DEFAULT_APPEARANCE }
}

let broadcast: ((payload: ThemePayload) => void) | null = null

/**
 * 广播出口由装配处注入（见 main/index.ts）。
 *
 * 不让本模块直接 import host.ipc 的 pushEventToRenderer：那会让
 * appearance -> ipc -> appearance 绕成一个环。
 */
export function registerAppearanceBroadcast(send: (payload: ThemePayload) => void): void {
  broadcast = send
}

export function getAppearancePreference(): AppearancePreference {
  return { ...current.preference }
}

export function getThemePayload(): ThemePayload {
  return current.payload
}

/** 当前配色的深浅。建窗时的窗口底色与启动参数用它 */
export function getCurrentPalette(): ThemePalette {
  return current.payload.palette
}

/** 窗口底色：与样式表里那种配色的页面底色一致（见 shared/theme 的 THEME_WINDOW_COLORS） */
export function getCurrentWindowColor(): string {
  return THEME_WINDOW_COLORS[getCurrentPalette()]
}

/**
 * 初始化：问 host 要一份状态并缓存。
 *
 * **必须在开窗之前完成**：窗口底色与启动参数都依赖它。host 不可达时保持深色兜底
 * 并记日志 —— 界面是深色，但不会没有配色。
 */
export async function initAppearance(): Promise<void> {
  try {
    current = await invokeHost<AppearanceState>('appearance', 'init')
  } catch (error) {
    logger.error('Failed to resolve the theme through host; keeping dark', { error })
  }

  /**
   * 系统外观变化（或 `themeSource` 被改动之后）时 Electron 会触发 updated。
   * 真正决定主题的是 host，所以这里只是让它重新算一次、变了再广播。
   */
  nativeTheme.on('updated', () => {
    void refreshFromHost('system appearance changed')
  })

  logger.info('Theme resolved', {
    theme: current.payload.theme,
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
export async function setThemePreference(theme: ThemeId, followSystem: boolean): Promise<boolean> {
  try {
    const next = await invokeHost<AppearanceState | null>('appearance', 'setTheme', [
      { theme, followSystem }
    ])
    if (!next) return false

    current = next
    // 偏好一定变了，所以强制推一次：即便解析出来的主题与之前相同，设置页的控件也要更新
    broadcast?.(next.payload)
    return true
  } catch (error) {
    logger.error('Failed to set the theme through host', { error })
    return false
  }
}

/** 系统外观变了：让 host 重算，真的变了才广播 */
async function refreshFromHost(reason: string): Promise<void> {
  try {
    const payload = await invokeHost<ThemePayload>('appearance', 'payload')
    if (payload.theme === current.payload.theme && payload.palette === current.payload.palette) {
      return
    }

    current = { ...current, payload }
    logger.debug('Theme broadcast', { reason, theme: payload.theme, palette: payload.palette })
    broadcast?.(payload)
  } catch (error) {
    logger.warn('Failed to refresh the theme through host', { error })
  }
}
