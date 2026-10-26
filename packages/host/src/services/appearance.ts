import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_APPEARANCE,
  normalizeAppearancePreference
} from '../../../../src/shared/appearance/preference.ts'
import {
  BUILTIN_THEMES,
  DEFAULT_THEME,
  findBuiltinTheme
} from '../../../../src/shared/theme/builtin.ts'
import { shell } from '../shell.ts'
import type {
  AppearancePreference,
  AppearanceState
} from '../../../../src/shared/appearance/preference.ts'
import type { ThemeId, ThemePalette, ThemePayload } from '../../../../src/shared/theme/types.ts'

/**
 * 主题 / 外观（host 侧）。
 *
 * 这一块此前在 shell（`src/main/appearance`）。搬过来的理由与 i18n 相同：偏好文件、
 * 「哪套主题生效」的解析都是业务状态，和插件、配置住在同一个进程才好推理；而
 * Electron 才有的那一点点（`nativeTheme`）通过反向桥（`shell.call`）够用。
 *
 * shell 仍然缓存一份 `AppearanceState`：开窗那一刻要**同步**拿到窗口底色与启动参数
 * （`--nide-appearance=` / `--nide-theme-palette=`），那一步跑不了 IPC。
 */

const FILE_NAME = 'appearance.json'

function warn(message: string, fields?: Record<string, unknown>): void {
  if (fields) console.warn(`[nide-host] ${message}`, fields)
  else console.warn(`[nide-host] ${message}`)
}

function info(message: string, fields?: Record<string, unknown>): void {
  if (fields) console.info(`[nide-host] ${message}`, fields)
  else console.info(`[nide-host] ${message}`)
}

export interface HostAppearanceOptions {
  /** Electron 的 userData 目录（`appearance.json` 落在这里） */
  userDataDir: string
}

export class HostAppearance {
  private readonly userDataDir: string
  private preference: AppearancePreference = { ...DEFAULT_APPEARANCE }

  constructor(options: HostAppearanceOptions) {
    this.userDataDir = options.userDataDir
  }

  /** 当前状态：载荷 + 用户选的那份偏好 */
  state(): AppearanceState {
    return { payload: this.payload(), preference: { ...this.preference } }
  }

  payload(): ThemePayload {
    const resolved = this.resolveCurrent()

    return {
      // fallbackFrom 有值时，theme 是**回落后实际生效**的那个
      theme: resolved.theme,
      palette: resolved.palette,
      available: [...BUILTIN_THEMES],
      ...(resolved.fallbackFrom ? { fallbackFrom: resolved.fallbackFrom } : {})
    }
  }

  /** 当前配色的深浅。窗口底色由 shell 用它算（`THEME_WINDOW_COLORS` 在共享层） */
  palette(): ThemePalette {
    return this.resolveCurrent().palette
  }

  /**
   * 初始化：读盘 -> 校验偏好里的主题是否存在 -> 把深浅落到 Electron 的原生部分。
   *
   * 与搬迁前一致：偏好认不出来时**只**在内存里回落（不写盘），界面靠 `fallbackFrom`
   * 提示；写盘等于替用户把那次手改「修好」，反而丢了线索。
   */
  async init(): Promise<AppearanceState> {
    this.preference = this.readPreference()

    if (!findBuiltinTheme(this.preference.theme)) {
      warn('Preferred theme is not available, falling back', {
        requested: this.preference.theme,
        fallback: DEFAULT_THEME
      })
      this.preference = { ...this.preference, theme: DEFAULT_THEME }
    }

    await this.applyNative()

    info('Theme resolved', {
      theme: this.payload().theme,
      palette: this.palette(),
      available: BUILTIN_THEMES.map((theme) => theme.id)
    })

    return this.state()
  }

  /**
   * 提交一套新主题。
   *
   * 返回 null 表示这个主题不存在，什么都没改。刻意**不重建窗口**：换主题只是换一个
   * 类名加一个原生明暗，各窗口收到广播后自己换掉即可，不会丢未保存的内容。
   */
  async setTheme(theme: ThemeId, followSystem: boolean): Promise<AppearanceState | null> {
    if (!findBuiltinTheme(theme)) {
      warn('Refusing to switch to a theme that is not available', { theme })
      return null
    }

    this.preference = { theme, followSystem }
    this.writePreference(this.preference)
    await this.applyNative()

    info('Theme preference updated', { theme, followSystem })
    return this.state()
  }

  private preferencePath(): string {
    return path.join(this.userDataDir, FILE_NAME)
  }

  private readPreference(): AppearancePreference {
    try {
      const raw = fs.readFileSync(this.preferencePath(), 'utf-8')
      return normalizeAppearancePreference(JSON.parse(raw))
    } catch {
      // 文件不存在 / 内容坏掉都不是错误，回落到默认值
      return { ...DEFAULT_APPEARANCE }
    }
  }

  private writePreference(preference: AppearancePreference): void {
    const target = this.preferencePath()
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, `${JSON.stringify(preference, null, 2)}\n`, 'utf-8')
    } catch (error) {
      // 写不进去只影响「下次启动还记得」，不该让这次切换整体失败
      warn('Failed to write the appearance preference', { error })
    }
  }

  /**
   * 算出当前要用的主题。
   *
   * `fallbackFrom` 会一路传到渲染进程：用户选的 id 认不出来时（偏好文件被手改、
   * 或那套主题已经不存在）必须**说出来**，否则界面只是"自己变回深色了"。
   */
  private resolveCurrent(): { theme: ThemeId; palette: ThemePalette; fallbackFrom?: ThemeId } {
    const found = findBuiltinTheme(this.preference.theme)
    if (found) return { theme: found.id, palette: found.palette }

    return {
      theme: DEFAULT_THEME,
      palette: findBuiltinTheme(DEFAULT_THEME)?.palette ?? 'dark',
      fallbackFrom: this.preference.theme
    }
  }

  /** 把当前配色的深浅落到 Electron 的原生部分（反向桥；独立运行时只记一条日志） */
  private async applyNative(): Promise<void> {
    const source = this.preference.followSystem ? 'system' : this.palette()
    try {
      await shell.call('nativeTheme.setSource', [source])
    } catch (error) {
      warn('Failed to apply the native theme', { source, error })
    }
  }
}
