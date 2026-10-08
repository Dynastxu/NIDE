import type { ElectronAPI } from '@electron-toolkit/preload'
import type { Disposable, PluginViewDescriptor } from '@shared/plugin-api'

export interface HostAPI {
  getPluginViews: () => Promise<PluginViewDescriptor[]>
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
  }
}

export {}
