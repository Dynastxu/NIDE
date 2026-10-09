import { app, BrowserWindow, ipcMain } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { installLogger, loggerFor } from './logger'
import { registerHostIPC } from './ipc/host.ipc'
import { registerWindowIPC, registerWindowActions } from './ipc/window.ipc'
import { initPluginHost } from './plugin-host'
import { initI18n } from './i18n'
import { createMainWindow, createSettingsWindow, recreateMainWindow } from './window'

/**
 * 日志必须最先安装，且早于 app.whenReady()。
 *
 * 两个理由：它在初始化时接管主进程的 console，越早接管越不容易漏掉启动期
 * 日志；而它自己写的第一行「Logger initialized」要在文件路径可解析之后立刻
 * 落地，这样任何后续启动失败都有一份「从哪开始坏」的记录。
 */
const logger = installLogger()

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
  // 1) IPC 通道要先注册好，渲染进程一打开就可能调用。
  //    registerWindowOpeners 必须在建窗之前 —— 渲染进程随时可能点「全局设置」，
  //    那时映射表要是空的，这次点击会静默丢掉（见 window.ipc.ts 的注入说明）。
  registerHostIPC()
  registerWindowIPC()
  registerWindowActions({
    openers: { settings: createSettingsWindow },
    restart: recreateMainWindow
  })
  // 2) 插件宿主只扫描 manifest、同步执行；语言包是随 manifest 一起注册进
  //    languagePackRegistry 的，所以 i18n 必须排在它后面，否则注册表还是空的，
  //    所有 locale 都会回落成中文
  initPluginHost()
  // 3) 定下语言：窗口标题、原生菜单、以及要传给渲染进程的启动参数都依赖它
  initI18n()
  // 4) 最后开窗：窗口一打开，渲染进程就能拿到完整的视图列表和词条表
  createMainWindow()

  logger.info('Startup sequence completed')

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

/**
 * 收尾日志。
 *
 * 刻意放在 will-quit 而不是 window-all-closed：后者在 macOS 上不退出进程，
 * 拿它当「应用结束」的信号会漏记。这里只写日志，不干预退出流程。
 */
app.on('will-quit', () => {
  loggerFor('app').info('Application is quitting')
})
