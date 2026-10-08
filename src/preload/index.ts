import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { DEFAULT_LOCALE, LOCALE_ARG_PREFIX } from '@shared/i18n'
import type { I18nPayload, LocaleId } from '@shared/i18n'
import type { Disposable } from '@shared/plugin-api'

// ========== 通用事件总线（渲染进程侧） ==========
const listeners = new Map<string, Set<(...args: unknown[]) => void>>()

ipcRenderer.on('host:event', (_event, channel: string, ...args: unknown[]) => {
  listeners.get(channel)?.forEach((handler) => handler(...args))
})

/**
 * 启动语言：从主进程建窗时喂进来的启动参数里**同步**读出来。
 *
 * 只给 Monaco 用（见 renderer 的 monaco-env.ts）—— 它必须在 monaco 模块被求值
 * 之前拿到语言，而那条路径上没有 await 的机会。完整的词条表仍然走异步的
 * host:get-i18n，两者不冲突：这份只有一个字符串。
 */
function readBootLocale(): LocaleId {
  const arg = process.argv.find((item) => item.startsWith(LOCALE_ARG_PREFIX))
  return arg ? arg.slice(LOCALE_ARG_PREFIX.length) : DEFAULT_LOCALE
}

const api = {
  /**
   * 获取所有插件注册的 UI 视图元信息。
   * 返回 [{ id, title, location, pluginId, dir, entry }] —— 纯数据。
   */
  getPluginViews: () => ipcRenderer.invoke('host:get-plugin-views'),

  /**
   * 获取当前语言的词条表、可用语言列表和漏翻体检结果。
   *
   * 渲染进程没有 fs，也不该知道语言包文件在哪 —— 它只消费主进程算好的结果。
   */
  getI18n: (): Promise<I18nPayload> => ipcRenderer.invoke('host:get-i18n'),

  /** 请求切换语言。真正生效需要重建窗口，由主进程自己处理 */
  setLocale: (locale: LocaleId): Promise<void> => ipcRenderer.invoke('host:set-locale', locale),

  /**
   * 事件总线：渲染进程向宿主（或插件后端）发送事件
   */
  emitEvent: (channel: string, ...args: unknown[]) => {
    ipcRenderer.send('host:event-emit', channel, ...args)
  },

  /**
   * 事件总线：渲染进程监听事件
   */
  onEvent: (channel: string, handler: (...args: unknown[]) => void): Disposable => {
    if (!listeners.has(channel)) {
      listeners.set(channel, new Set())
    }
    listeners.get(channel)!.add(handler)
    return {
      dispose: () => {
        listeners.get(channel)?.delete(handler)
      }
    }
  },

  /** 编辑器内容变化通知主进程 */
  notifyEditorChange: (filePath: string, content: string) => {
    ipcRenderer.send('host:editor-change', filePath, content)
  },

  /** 宿主请求展示 Diff（Monaco Diff 组件消费） */
  onShowDiff: (handler: (original: string, modified: string) => void): Disposable => {
    const wrapped = (_e: unknown, original: string, modified: string): void =>
      handler(original, modified)
    ipcRenderer.on('host:show-diff', wrapped)
    return {
      dispose: () => ipcRenderer.off('host:show-diff', wrapped)
    }
  },

  /** 宿主刷新 Monaco 编辑器内容 */
  onFileChanged: (handler: (filePath: string, content: string) => void): Disposable => {
    const wrapped = (_e: unknown, filePath: string, content: string): void =>
      handler(filePath, content)
    ipcRenderer.on('host:file-changed', wrapped)
    return {
      dispose: () => ipcRenderer.off('host:file-changed', wrapped)
    }
  },

  /** 弹出按钮条的右键菜单，返回「显示标题」的最新勾选状态 */
  showStripeMenu: (showTitles: boolean): Promise<boolean> =>
    ipcRenderer.invoke('host:show-stripe-menu', showTitles),

  /** 插件管理（占位） */
  reloadPlugin: (pluginId: string) => ipcRenderer.invoke('host:reload-plugin', pluginId)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('hostAPI', api)
    contextBridge.exposeInMainWorld('__NIDE_BOOT__', { locale: readBootLocale() })
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.hostAPI = api
  // @ts-ignore (define in dts)
  window.__NIDE_BOOT__ = { locale: readBootLocale() }
}
