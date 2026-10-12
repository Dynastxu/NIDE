import { create } from 'zustand'
import { DEFAULT_APPEARANCE } from '@shared/appearance'
import { DEFAULT_THEME } from '@shared/theme'
import { applyPalette as applyPaletteToDom } from '@renderer/appearance/palette'
import { loggerFor } from '../logger'
import type { AppearancePreference } from '@shared/appearance'
import type { ThemeDescriptor, ThemeId, ThemePalette, ThemePayload } from '@shared/theme'

const logger = loggerFor('appearance')

/**
 * 主题在渲染进程侧的状态。
 *
 * ## 为什么不是 zustand 的 persist
 *
 * 布局（layout.store）用 persist + localStorage 就够了，主题不行：**主进程**在开窗
 * 之前就要知道用哪套配色（窗口底色、原生对话框的明暗）。localStorage 在渲染进程里，
 * 主进程读不到 —— 所以真相来源在主进程的 userData 里，渲染进程这一份是**投影**，
 * 由启动参数（首帧）加广播（之后）喂进来。
 *
 * ## 渲染进程要做的只有一件事
 *
 * 给根元素挂一个类名。配色本身在样式表里：
 * - 深色 = 组件里那些原始色阶（`bg-zinc-900` …），什么都不用挂；
 * - 浅色 = `assets/light.css`，它靠 `.theme-light` 前缀盖过那些色阶。
 *
 * 所以这里没有"令牌"、没有 CSS 变量注入 —— 换主题就是换一个类名。
 */
interface AppearanceState {
  preference: AppearancePreference
  /** 实际生效的深浅。根元素的类名绑它 */
  palette: ThemePalette
  available: ThemeDescriptor[]
  /** 有值表示请求的主题不存在、被回落了。界面据此提示 */
  fallbackFrom?: ThemeId

  /** 主进程广播 / 主动拉取来的权威载荷 */
  receive: (payload: ThemePayload) => void
  /** 首次拉取可选主题与当前主题（窗口启动后一次） */
  load: () => Promise<void>
  /**
   * 提交一套主题。**只发请求**，不乐观更新：主进程会校验主题是否存在，
   * 失败了要能退回来，而界面先跳过去再退回来是最糟的表现。
   */
  setTheme: (theme: ThemeId) => Promise<boolean>
}

export const useAppearanceStore = create<AppearanceState>((set) => ({
  /**
   * 首帧的两份初始值都来自**启动参数**，没有一个是异步的。
   *
   * 这不是优化而是正确性：主进程的广播只发得给建窗时已经存在的窗口，而启动阶段
   * 窗口是一个一个建的 —— 靠广播回填会让首帧按深色画一遍（选浅色时整屏闪）。
   */
  preference: bootAppearance(),
  palette: bootPalette(),
  available: [],

  receive: (payload) =>
    set((state) => ({
      preference: { theme: payload.theme, followSystem: state.preference.followSystem },
      palette: payload.palette,
      available: payload.available,
      ...(payload.fallbackFrom ? { fallbackFrom: payload.fallbackFrom } : {})
    })),

  load: async () => {
    try {
      const payload = await window.hostAPI.appearance.get()
      useAppearanceStore.getState().receive(payload)
      applyPalette(payload.palette)
    } catch (err) {
      // 拿不到不算致命：启动参数已经给了能用的配色，只是设置页的主题列表是空的
      logger.error('Failed to load the theme payload, keeping the boot theme', { error: err })
    }
  },

  setTheme: async (theme) => {
    try {
      return await window.hostAPI.appearance.setTheme(theme)
    } catch (err) {
      logger.error('Failed to submit the theme', { theme, error: err })
      return false
    }
  }
}))

/** 启动参数里的完整偏好（含"跟随系统"）。读不到时用 shared 的默认值 */
function bootAppearance(): AppearancePreference {
  return window.__NIDE_BOOT__?.appearance ?? DEFAULT_APPEARANCE
}

/**
 * 启动参数里的深浅。
 *
 * 读不到时按深色算：深色是组件里写死的那套配色，也就是"什么都不挂"的默认状态 ——
 * 这个回落永远不会画出错误颜色。
 */
function bootPalette(): ThemePalette {
  return window.__NIDE_BOOT__?.themePalette ?? 'dark'
}

/**
 * 应用一套配色：落 DOM + 落 store。
 *
 * 两件事必须一起做，所以合成一个函数：
 * - 落 DOM（挂 `.theme-light`）与通知订阅者（Monaco）在 `appearance/palette` 里；
 * - 落 store 是为了让设置页和其它消费者能**响应式**地读到当前深浅。
 */
export function applyPalette(palette: ThemePalette): void {
  applyPaletteToDom(palette)
  useAppearanceStore.setState({ palette })
}

/**
 * 渲染进程侧的主题接线。**必须在首帧渲染之前调用**（main.tsx 的启动序列里）。
 *
 * 四件事：
 * 1. 按启动参数决定首帧挂不挂 `.theme-light`；
 * 2. 把深浅落到 store 上（设置页与其它消费者读的是它）；
 * 3. 接上主进程的广播（用户换了、别的窗口换了都走它）；
 * 4. 拉一次可选主题列表 —— 广播只讲"现在用哪套"，列表是另一件事。
 *
 * 真正"挂类名 + 通知订阅者"那一步在 `@renderer/appearance/palette`，因为 Monaco
 * 也要消费这个值，而它不该被拖进设置窗口（见那个文件的说明）。
 */
export function initAppearance(): void {
  applyPalette(bootPalette())

  window.hostAPI.appearance.onChanged((payload) => {
    useAppearanceStore.getState().receive(payload)
    applyPalette(payload.palette)
  })

  void useAppearanceStore.getState().load()
}

/** 当前选中的主题 id。设置页用它初始化草稿 */
export function currentThemeId(): ThemeId {
  return useAppearanceStore.getState().preference.theme || DEFAULT_THEME
}
