import { app, BrowserWindow, ipcMain } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { APPEARANCE_CHANNEL } from '@shared/appearance'
import { installLogger, loggerFor } from './logger'
import { registerConfirmIPC } from './confirm'
import { installQuitGate } from './lifecycle'
import { registerHostIPC, pushEventToRenderer } from './ipc/host.ipc'
import { registerProjectIPC } from './ipc/project.ipc'
import { registerWindowIPC, registerWindowActions } from './ipc/window.ipc'
import { registerAiProviderIPC, shutdownAiProviderIPC } from './ipc/ai-provider.ipc'
import { initPluginHost } from './plugin-host'
import { startHost, stopHost, attachHostPort } from './host/process'
import { initI18n } from './i18n'
import { initAppearance, registerAppearanceBroadcast } from './appearance'
import { registerPluginBundleProtocol, registerPluginBundleScheme } from './protocol/plugin-bundles'
import { createSettingsWindow, openStartupWindow, recreateRootWindow } from './window'

/**
 * 日志必须最先安装，且早于 app.whenReady()。
 *
 * 两个理由：它在初始化时接管主进程的 console，越早接管越不容易漏掉启动期
 * 日志；而它自己写的第一行「Logger initialized」要在文件路径可解析之后立刻
 * 落地，这样任何后续启动失败都有一份「从哪开始坏」的记录。
 */
const logger = installLogger()

/**
 * 自定义 scheme 的权限位只能在 ready **之前**登记，所以这一句刻意放在模块顶层。
 * 处理器本身在 ready 之后挂（见下面的 `registerPluginBundleProtocol`）。
 */
registerPluginBundleScheme()

app.whenReady().then(async () => {
  // 必须和 electron-builder.yml 的 appId 保持一致：Windows 靠 AppUserModelID
  // 归组任务栏图标、关联通知，两边不一致时通知会挂到别的应用名下。
  // Electron 没有在运行时读 appId 的 API，所以只能硬编码，改动时两处一起改。
  electronApp.setAppUserModelId('com.github.dynastxu.nide')

  // 打包后插件 UI 靠它取 bundle（开发期走 Vite 的 /@fs/，用不到）
  registerPluginBundleProtocol()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
    /**
     * 每个窗口加载完成后，把 host 的直连 port 交给它。
     *
     * 放在 `did-finish-load` 而不是建窗时：preload 要先注册好接收器，
     * 否则 port 会被丢掉。host 还没 ready 时 attachHostPort 会等它。
     */
    window.webContents.once('did-finish-load', () => {
      attachHostPort(window.webContents, `window-${window.id}`)
    })
  })

  ipcMain.on('ping', () => console.log('pong'))

  // 顺序有约束，不能调换：
  // 1) IPC 通道要先注册好，渲染进程一打开就可能调用。
  //    registerWindowOpeners 必须在建窗之前 —— 渲染进程随时可能点「全局设置」，
  //    那时映射表要是空的，这次点击会静默丢掉（见 window.ipc.ts 的注入说明）。
  //    项目通道同理：欢迎窗口一挂载就会取项目列表。
  registerHostIPC()
  registerProjectIPC()
  registerWindowIPC()
  // AI 供应商：设置页的读写与 Agent 的透明转发。放在窗口创建之前注册，
  // 因为设置窗口一挂载就会拉列表。
  registerAiProviderIPC()
  /**
   * 行为级二次确认：回答通道要尽早注册（渲染进程一挂载就可能回答），退出确认的
   * 关口也在这里装上 —— 它管的是后面每一次 `app.quit()`，包括最后一个窗口关掉
   * 之后自动触发的那一次（见 lifecycle.ts 的说明）。
   */
  registerConfirmIPC()
  installQuitGate()
  registerWindowActions({
    openers: { settings: createSettingsWindow },
    restart: recreateRootWindow
  })
  /**
   * 宿主进程 —— 从这里开始，启动**串行**了。
   *
   * 项目文件 / 配置 / 插件目录的实现全部在 host，所以它不再是开关：启动时无条件
   * 拉起。而且后面两步都要等它：插件贡献点（视图 / 设置页 / 语言包）由 host 读盘
   * 下发，开哪个根窗口又取决于 host 读出来的 `projects.json`。
   *
   * host 起不来时**不阻塞启动**：`initPluginHost` 会降级成空贡献点、`openStartupWindow`
   * 会回落成欢迎窗口，日志里有原因。窗口照常出现，只是什么都读不了。
   */
  try {
    await startHost()
    logger.info('host process is ready')
  } catch (error) {
    logger.error('host process failed', { error })
  }

  /**
   * 2) 插件贡献点：拉一次，灌进 shell 的注册表。
   *
   * 语言包是随贡献点一起下发的，所以 i18n 必须排在它后面，否则词条表还是空的，
   * 所有 locale 都会回落成中文。
   */
  await initPluginHost()
  // 3) 定下语言：窗口标题、原生菜单、以及要传给渲染进程的启动参数都依赖它
  initI18n()
  /**
   * 3.5) 定下主题：必须在开窗**之前**（窗口底色与启动参数都用得到），
   * 且广播出口在这里注入 —— appearance 模块不直接依赖 IPC 模块，
   * 否则会绕成 appearance -> ipc -> appearance 的循环。
   *
   * 放在 initI18n 之后只是为了让日志顺序与"语言 -> 主题"的阅读顺序一致，
   * 两者之间没有依赖。
   */
  initAppearance()
  registerAppearanceBroadcast((payload) => pushEventToRenderer(APPEARANCE_CHANNEL, payload))
  // 4) 最后开窗：窗口一打开，渲染进程就能拿到完整的视图列表和词条表。
  //    开哪个窗口由「打开过的项目」决定 —— 那份记录现在只有 host 在读，
  //    所以这一步是异步的：host ready 之后才知道该进主窗口还是欢迎窗口
  //    （见 window.ts 的 openStartupWindow）
  void openStartupWindow()
    .then(() => logger.info('Startup sequence completed'))
    .catch((error) => logger.error('Failed to open the startup window', { error }))

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) void openStartupWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    /**
     * 这一次 `app.quit()` 会经过 lifecycle.ts 的退出确认，但**不会再问一遍**：
     * 走到这里说明窗口已经全没了，没有地方画浮层，而那时候用户刚刚亲手关掉了
     * 最后一个窗口 —— 那道门对「问不出去」的情形是放行的（理由见 lifecycle.ts）。
     */
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
  // 先给 host 一个优雅退出的机会；app 退出本身不会等它，超时由 stopHost 内部 kill。
  void stopHost()
  // SSE 是长连接，退出时主动取消，别让 fetch 把进程拖在后台
  shutdownAiProviderIPC()
  loggerFor('app').info('Application is quitting')
})
