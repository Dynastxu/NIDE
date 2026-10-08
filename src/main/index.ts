import { app, BrowserWindow, ipcMain } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerHostIPC } from './ipc/host.ipc'
import { initPluginHost } from './plugin-host'
import { initI18n } from './i18n'
import { createMainWindow } from './window'

app.whenReady().then(() => {
  // 必须和 electron-builder.yml 的 appId 保持一致：Windows 靠 AppUserModelID
  // 归组任务栏图标、关联通知，两边不一致时通知会挂到别的应用名下。
  // Electron 没有在运行时读 appId 的 API，所以只能硬编码，改动时两处一起改。
  electronApp.setAppUserModelId('com.github.dynastxu.nide')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => console.log('pong'))

  // 顺序有约束，不能调换：
  // 1) IPC 通道要先注册好，渲染进程一打开就可能调用
  registerHostIPC()
  // 2) 插件宿主只扫描 manifest、同步执行；语言包是随 manifest 一起注册进
  //    languagePackRegistry 的，所以 i18n 必须排在它后面，否则注册表还是空的，
  //    所有 locale 都会回落成中文
  initPluginHost()
  // 3) 定下语言：窗口标题、原生菜单、以及要传给渲染进程的启动参数都依赖它
  initI18n()
  // 4) 最后开窗：窗口一打开，渲染进程就能拿到完整的视图列表和词条表
  createMainWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
