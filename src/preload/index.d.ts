import type { ElectronAPI } from '@electron-toolkit/preload'
import type { I18nPayload, LocaleId } from '@shared/i18n'
import type { Disposable, PluginViewDescriptor } from '@shared/plugin-api'

/**
 * preload 在渲染进程里同步暴露的启动信息。
 *
 * 只有一个 locale，因为它是 Monaco NLS 唯一需要的东西 —— 而 Monaco NLS 必须
 * 在 monaco 模块求值前设好，早于任何一次异步 IPC。
 */
export interface NideBootInfo {
  /** 主进程建窗时定下的语言（BCP-47），例如 "zh-CN" */
  locale: LocaleId
}

export interface HostAPI {
  getPluginViews: () => Promise<PluginViewDescriptor[]>
  getI18n: () => Promise<I18nPayload>
  setLocale: (locale: LocaleId) => Promise<void>
  emitEvent: (channel: string, ...args: unknown[]) => void
  onEvent: (channel: string, handler: (...args: unknown[]) => void) => Disposable
  notifyEditorChange: (filePath: string, content: string) => void
  onShowDiff: (handler: (original: string, modified: string) => void) => Disposable
  onFileChanged: (handler: (filePath: string, content: string) => void) => Disposable
  showStripeMenu: (showTitles: boolean) => Promise<boolean>
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
