import type { ElectronAPI } from '@electron-toolkit/preload'
import type { I18nPayload, LocaleId } from '@shared/i18n'
import type { Disposable, PluginDescriptor, PluginViewDescriptor } from '@shared/plugin-api'
import type { WindowAction, WindowState, WindowType } from '@shared/window'

/**
 * preload 在渲染进程里同步暴露的启动信息。
 *
 * 两项都必须**同步**可得，因为渲染进程要在第一帧、任何异步 IPC 之前就用到：
 * - locale 是 Monaco NLS 唯一需要的东西，而它必须在 monaco 模块求值前设好；
 * - windowType 决定挂载哪个根组件，晚一步拿到就会先渲染错的界面。
 */
export interface NideBootInfo {
  /** 主进程建窗时定下的语言（BCP-47），例如 "zh-CN" */
  locale: LocaleId
  /** 这个窗口是哪种窗口。渲染进程据此选根组件 */
  windowType: WindowType
}

/**
 * 窗口本体能力。每个窗口都有，和「宿主业务能力」刻意分开：
 * 最小化/最大化/关闭是窗口自己的事，跟插件、编辑器没关系。
 */
export interface WindowAPI {
  /** 同步读一次窗口状态。异步会让第一帧画出错的按钮 */
  getState: () => WindowState
  onStateChange: (handler: (state: WindowState) => void) => Disposable
  action: (action: WindowAction) => void
  open: (type: WindowType) => Promise<void>
  /** 重建主窗口。发出去就结束，不等回执（这个窗口自己会被销毁） */
  restart: () => void
}

export interface HostAPI {
  getPluginViews: () => Promise<PluginViewDescriptor[]>
  getPlugins: () => Promise<PluginDescriptor[]>
  setPluginEnabled: (pluginId: string, enabled: boolean) => Promise<void>
  getDisabledPlugins: () => Promise<string[]>
  onPluginEnabledChanged: (handler: (pluginId: string, enabled: boolean) => void) => Disposable
  getI18n: () => Promise<I18nPayload>
  setLocale: (locale: LocaleId) => Promise<void>
  emitEvent: (channel: string, ...args: unknown[]) => void
  onEvent: (channel: string, handler: (...args: unknown[]) => void) => Disposable
  notifyEditorChange: (filePath: string, content: string) => void
  onShowDiff: (handler: (original: string, modified: string) => void) => Disposable
  onFileChanged: (handler: (filePath: string, content: string) => void) => Disposable
  showStripeMenu: (showTitles: boolean) => Promise<boolean>
  window: WindowAPI
  reloadPlugin: (pluginId: string) => Promise<void>
}

declare global {
  interface Window {
    electron: ElectronAPI
    hostAPI: HostAPI
    __NIDE_BOOT__: NideBootInfo
  }
}

export {}
