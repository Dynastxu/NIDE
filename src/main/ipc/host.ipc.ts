import { ipcMain, webContents } from 'electron'
import { uiRegistry } from '../plugin-host/ui-registry'
import type { PluginViewDescriptor } from '@shared/plugin-api'

export function registerHostIPC(): void {
  // 渲染进程拿到的只是「有哪些视图」这份纯数据，
  // 组件怎么加载由渲染进程自己决定（构建期 import.meta.glob）。
  ipcMain.handle('host:get-plugin-views', (): PluginViewDescriptor[] => uiRegistry.getAll())

  // 渲染进程 -> 宿主 的事件总线
  ipcMain.on('host:event-emit', (_e, channel: string, ...args: unknown[]) => {
    console.log(`[host:event-emit] ${channel}`, args)
    // 目前还没有插件后端，先把事件回显给渲染进程，用来验证事件总线是通的
    pushEventToRenderer(`echo:${channel}`, ...args)
  })

  // 编辑器内容变化（先落日志，后续用于脏标记 / 持久化）
  ipcMain.on('host:editor-change', (_e, filePath: string, content: string) => {
    console.log(`[host:editor-change] ${filePath} (${content.length} chars)`)
  })

  // 插件重载（占位，等插件后端接上再实现）
  ipcMain.handle('host:reload-plugin', (_e, pluginId: string) => {
    console.log(`[host:reload-plugin] ${pluginId} (not implemented yet)`)
  })
}

/** 宿主 -> 渲染进程：推送事件 */
export function pushEventToRenderer(channel: string, ...args: unknown[]): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue
    wc.send('host:event', channel, ...args)
  }
}

/** 宿主 -> 渲染进程：通知文件已变化 */
export function notifyFileChanged(filePath: string, content: string): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue
    wc.send('host:file-changed', filePath, content)
  }
}

/** 宿主 -> 渲染进程：请求展示 Diff */
export function requestShowDiff(original: string, modified: string): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue
    wc.send('host:show-diff', original, modified)
  }
}
