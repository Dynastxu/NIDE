import { BrowserWindow, Menu, dialog, ipcMain, webContents } from 'electron'
import { WINDOW_CHANNELS } from '@shared/window'
import { uiRegistry } from '../plugin-host/ui-registry'
import { pluginRegistry } from '../plugin-host/plugin-registry'
import { createMainTranslator, getCurrentLocale, getI18nPayload, switchLocale } from '../i18n'
import { manifestNlsRegistry } from '../i18n/manifest-nls'
import { loggerFor, toLogRecord } from '../logger'
import { getMainWindow, recreateRootWindow } from '../window'
import type { I18nPayload, LocaleId } from '@shared/i18n'
import type { PluginDescriptor, PluginViewDescriptor } from '@shared/plugin-api'

const logger = loggerFor('host')
const pluginLogger = loggerFor('plugin-host')

/**
 * 被禁用的插件 id。
 *
 * 进程内的内存状态，**不落盘** —— 见 host:set-plugin-enabled 的说明。
 * 放模块作用域而不是塞进某个注册表：它既不属于清单（磁盘事实），
 * 也不属于视图注册表（贡献点），而是第三种东西：用户偏好。
 * 等偏好持久化落地时，这里换成一个读写 store 的调用即可，调用点不用动。
 */
const disabledPlugins = new Set<string>()

/**
 * 插件启用状态变化的事件名。
 *
 * 走既有的 `host:event-emit` 那套事件总线（host:event 通道 + 频道名），
 * 而不是新开一条 IPC：这就是一条「宿主通知所有窗口」的广播，形状完全一样。
 */
export const PLUGIN_STATE_CHANGED_EVENT = 'plugin:enabled-changed'

/**
 * 切语言：先用**当前**语言征求同意，再落盘、重建窗口。
 *
 * 为什么要确认：重建窗口会丢掉渲染进程的未保存状态。语言是低频操作，
 * 静默丢掉用户的编辑内容不可接受，所以这里宁可多问一句。
 */
async function applyLocaleSwitch(locale: LocaleId): Promise<void> {
  // 注意用的是「切换前」的 t()：确认框必须用用户此刻看得懂的语言写
  const t = createMainTranslator()
  const payload = getI18nPayload()
  const label = payload.available.find((d) => d.locale === locale)?.label ?? locale

  const parent = getMainWindow()
  /**
   * 按钮下标：0 = 确认，1 = 取消。
   *
   * `defaultId` 刻意指向**取消**：确认按钮会重建窗口、丢掉未保存的编辑内容，
   * 让回车直接落在破坏性操作上不合适。这样回车和 Esc 都是取消，要切换必须
   * 明确地点一下确认。
   */
  const CONFIRM = 0
  const options = {
    type: 'question' as const,
    buttons: [t('host.locale.switch.confirm'), t('host.locale.switch.cancel')],
    defaultId: 1,
    cancelId: 1,
    /**
     * 显式关掉 Windows 的 command link 猜测。**不要删。**
     *
     * Electron 会拿按钮**文案**去匹配 "Cancel" / "Yes" 这类英文词，命中的渲染成
     * 常规小按钮，其余的在正文区渲染成大块 command link。这个判定只认英文，
     * 于是同一个对话框会随界面语言换一套排版。实测过的对照：
     *
     *   中文（"切换并重启" / "取消" 都不命中）-> 两个都成 command link -> 两个大按钮
     *   英文（"Cancel" 命中）-> 一个是标准小按钮 + 一个是 command link -> 一大一小
     *
     * 表现就是「切语言后取消按钮跑到别处去了」—— 尺寸和位置同时变。
     * noLink: true 一律用普通按钮，把排版从文案手里拿回来。
     *
     * 但它只管**样式**，不管**顺序**：左右次序由系统决定，Electron 没有暴露
     * 控制它的开关。这里靠 buttons 数组顺序 + cancelId 保证两语言一致。
     */
    noLink: true,
    message: t('host.locale.switch.title'),
    detail: t('host.locale.switch.message', { label })
  }

  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)

  if (response !== CONFIRM) return

  if (!switchLocale(locale)) {
    const failed = { type: 'error' as const, message: t('host.locale.switch.failed', { locale }) }
    if (parent) await dialog.showMessageBox(parent, failed)
    else await dialog.showMessageBox(failed)
    return
  }

  recreateRootWindow()
}

export function registerHostIPC(): void {
  /**
   * 渲染进程拿到的只是「有哪些视图」这份纯数据，
   * 组件怎么加载由渲染进程自己决定（构建期 import.meta.glob）。
   *
   * manifest 的标题在这里**按当前语言解析**，而不是在插件扫描时。
   * 原因是时序：扫描 manifest 发生在 initI18n() 之前，那时还不知道用哪个语言。
   * 放到查询时解析还有个附带好处 —— 切语言重建窗口后渲染进程重新取一次
   * 视图列表，标题就跟着变了，不需要任何重载逻辑。
   */
  ipcMain.handle('host:get-plugin-views', (): PluginViewDescriptor[] => {
    const locale = getCurrentLocale()
    return uiRegistry.getAll().map(({ titleSpec, ...view }) => ({
      ...view,
      title: manifestNlsRegistry.resolve(view.pluginId, titleSpec, locale) ?? view.id
    }))
  })

  /**
   * 渲染进程启动时取词条表。
   *
   * 走 IPC 而不是让渲染进程自己读盘：渲染进程在 Chromium 沙箱里没有 fs，
   * 而且打包后插件可能躺在 asar 里 —— 只有主进程能读。
   */
  ipcMain.handle('host:get-i18n', (): I18nPayload => getI18nPayload())

  /**
   * 「设置 -> 插件」要的清单：装了哪些插件。
   *
   * 和 host:get-plugin-views 是两件事：那个回答「界面上有哪些视图」，这个回答
   * 「磁盘上有哪些插件」。纯数据插件（语言包）只有后者认得，而设置界面必须
   * 把它们列出来 —— 用户装了个语言包却在插件列表里找不到，那是最容易踩的坑。
   */
  ipcMain.handle('host:get-plugins', (): PluginDescriptor[] => {
    return pluginRegistry
      .getAll()
      .map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        builtin: plugin.source === 'builtin',
        dir: plugin.dir,
        permissions: plugin.permissions,
        views: plugin.views,
        requiresRestart: plugin.requiresRestart,
        ...(plugin.description ? { description: plugin.description } : {})
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  })

  /**
   * 启用 / 禁用插件。
   *
   * 「禁用」的效果**立刻可见**，因为它落在渲染进程侧：被禁用的插件，它的视图
   * 会从工具区消失（见 renderer 的 plugin.store）。宿主这边只记状态。
   *
   * 刻意**不做**的两件事：
   * - 不落盘。重启后回到全部启用。偏好持久化要等一个统一的宿主偏好存储，
   *   现在各写各的（布局走 localStorage、语言走 userData 的一个文件）已经够乱了。
   * - 不重建窗口。禁用是高频的试错操作，每次都重建窗口会丢掉编辑器里未保存的内容 ——
   *   而语言切换之所以能那样做，是因为它低频且真的无法热更新。
   */
  ipcMain.handle('host:set-plugin-enabled', (_event, pluginId: string, enabled: boolean): void => {
    if (enabled) disabledPlugins.delete(pluginId)
    else disabledPlugins.add(pluginId)

    pluginLogger.info(`Plugin ${enabled ? 'enabled' : 'disabled'}`, { pluginId })

    /**
     * 广播给**所有**窗口。
     *
     * 必要性来自窗口模型：设置窗口和主窗口是两个渲染进程，各自持有一份 zustand
     * store。在设置窗口里取消勾选、主窗口那边不会有任何变化 —— 除非有人告诉它。
     * pushEventToRenderer 是既有的宿主 -> 全窗口广播通道，这里正好是它的用途。
     */
    pushEventToRenderer(PLUGIN_STATE_CHANGED_EVENT, pluginId, enabled)
  })

  /** 当前被禁用的插件。渲染进程启动时取一次，用来过滤视图列表 */
  ipcMain.handle('host:get-disabled-plugins', (): string[] => [...disabledPlugins])

  /** 渲染进程/插件请求切换语言；真正生效靠重建窗口，所以走和菜单同一条路径 */
  ipcMain.handle('host:set-locale', async (_e, locale: LocaleId): Promise<void> => {
    await applyLocaleSwitch(locale)
  })

  // 渲染进程 -> 宿主 的事件总线
  ipcMain.on('host:event-emit', (_e, channel: string, ...args: unknown[]) => {
    /**
     * 只记频道名和参数个数，**不记参数内容**。
     *
     * 这条通道承载的是插件事件的任意载荷，里面可能是文档正文或用户的
     * 项目路径 —— 原样进日志等于把用户内容抄进磁盘。排查事件是否送达，
     * 频道名加条数就够了。
     */
    logger.debug('Renderer event emitted', { channel, argCount: args.length })
    // 目前还没有插件后端，先把事件回显给渲染进程，用来验证事件总线是通的
    pushEventToRenderer(`echo:${channel}`, ...args)
  })

  // 编辑器内容变化（先落日志，后续用于脏标记 / 持久化）
  ipcMain.on('host:editor-change', (_e, filePath: string, content: string) => {
    /**
     * debug 级别：这条消息**每次按键**都会来，info 级别会让日志文件被逐键
     * 记录冲掉。要排查它时把 NIDE_LOG_LEVEL 设成 debug。
     */
    logger.debug('Editor content changed', { filePath, chars: content.length })
  })

  // 插件重载（占位，等插件后端接上再实现）
  ipcMain.handle('host:reload-plugin', (_e, pluginId: string) => {
    pluginLogger.info('Plugin reload requested', { pluginId, implemented: false })
  })

  /**
   * 接收渲染进程与预加载转发来的日志。
   *
   * 落点是主进程的 file transport，所以三个进程的日志最终在同一份文件里。
   * 这里只做形状校验，不做级别判断 —— 级别在发送方已经判过一次，而主进程的
   * file transport 本身就收全级别（它的作用是把完整记录写下来）。
   */
  ipcMain.on(WINDOW_CHANNELS.log, (_e, payload: unknown) => {
    const record = toLogRecord(payload)
    if (!record) return

    loggerFor(record.scope).dispatch(record.level, record.text, record.fields)
  })

  /**
   * 工具区按钮条的右键菜单。
   *
   * 原生菜单：勾选状态由 Electron 自己维护，主进程只负责把「最终值」回传给
   * 渲染进程 —— 渲染进程不需要知道菜单长什么样。菜单关闭（点了或点外面取消）
   * 后统一 resolve，取消时值不变，渲染进程直接 set 即可。
   *
   * 语言切换**曾经**也挂在这里，现在挪到设置窗口的语言页了。这里刻意不再放它：
   * 切语言要重建窗口（会丢未保存内容、要确认），而右键菜单是个轻量、无确认的
   * 交互面 —— 把一个破坏性操作塞进右键菜单，用户点中的代价和收益不成比例。
   */
  ipcMain.handle('host:show-stripe-menu', (event, showTitles: boolean): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      const t = createMainTranslator()
      let next = showTitles

      const menu = Menu.buildFromTemplate([
        {
          label: t('host.stripe.menu.showTitles'),
          type: 'checkbox',
          checked: showTitles,
          click: (item) => {
            next = item.checked
          }
        }
      ])

      const win = BrowserWindow.fromWebContents(event.sender)
      menu.popup({
        ...(win ? { window: win } : {}),
        callback: () => resolve(next)
      })
    })
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
