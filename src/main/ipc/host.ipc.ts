import { BrowserWindow, Menu, dialog, ipcMain, webContents } from 'electron'
import { WINDOW_CHANNELS } from '@shared/window'
import { HOST_CHANNELS, HOST_EVENT_CHANNELS } from '@shared/host'
import { AI_PROVIDER_PLUGIN_ID } from '@shared/ai-provider'
import { normalizeAppearancePreference } from '@shared/appearance'
import { HOST_VIEW_PLUGIN_ID } from '@shared/plugin-api'
import { HOST_VIEWS } from '../plugin-host/host-views'
import {
  getDisabledPlugins,
  reloadPluginPreference,
  setPluginEnabled
} from '../plugin-host/preference'
import { getAppearancePreference, getThemePayload, setThemePreference } from '../appearance'
import { createMainTranslator, getI18nPayload, switchLocale } from '../i18n'
import { loggerFor, toLogRecord } from '../logger'
import { getMainWindow, recreateRootWindow } from '../window'
import { invokeHost } from '../host/process'
import { CONFIRM_SPECS, isActionConfirmed } from '../confirm'
import { shutdownAiProviderIPC } from './ai-provider.ipc'
import type { I18nPayload, LocaleId } from '@shared/i18n'
import type { ThemePayload } from '@shared/theme'
import type {
  ClientBundleDescriptor,
  PluginDescriptor,
  PluginInstallResult,
  PluginRemoveResult,
  PluginSettingsDescriptor,
  PluginViewDescriptor
} from '@shared/plugin-api'

const logger = loggerFor('host')
const pluginLogger = loggerFor('plugin-host')

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

  if (!(await switchLocale(locale))) {
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
   * 插件视图的标题由 **host 按当前语言解析好**（语言与词条表都在那边）；
   * 宿主内建视图（文件树 / 版本控制 / 提交）的标题是宿主自己的词条，只能在 shell
   * 用缓存的载荷翻 —— 所以这里拼在**前面**。
   *
   * 顺序有实际意义：排在前面的视图是各自区的**第一个**，也就是该区 activeViewId
   * 为 null 时默认展示的那一个 —— 打开工作台就该看见文件树，而不是演示面板。
   */
  ipcMain.handle(HOST_CHANNELS.getPluginViews, async (): Promise<PluginViewDescriptor[]> => {
    const t = createMainTranslator()

    const hostViews: PluginViewDescriptor[] = HOST_VIEWS.map((view) => ({
      id: view.id,
      title: t(view.titleKey),
      location: view.location,
      icon: view.icon,
      pluginId: HOST_VIEW_PLUGIN_ID,
      // 内建视图的组件编译在宿主里，没有插件目录，也没有入口文件
      dir: '',
      entry: ''
    }))

    try {
      const pluginViews = await invokeHost<PluginViewDescriptor[]>('plugins', 'views', [])
      return [...hostViews, ...pluginViews]
    } catch (error) {
      // 读不到插件视图时至少保住内建视图：界面还能用，只是少了插件那一批
      logger.error('Failed to read the plugin views through host', { error })
      return hostViews
    }
  })

  /**
   * 全局设置里的插件子设置。
   *
   * host 只回**已启用**插件的页，并按 order / 标题排好；这里不再筛、不再排。
   * 启用状态变化后 shell 会广播 `plugin:enabled-changed`，设置窗口据此重拉。
   */
  ipcMain.handle(HOST_CHANNELS.getPluginSettings, async (): Promise<PluginSettingsDescriptor[]> => {
    try {
      return await invokeHost<PluginSettingsDescriptor[]>('plugins', 'settings', [])
    } catch (error) {
      logger.error('Failed to read the plugin settings pages through host', { error })
      return []
    }
  })

  /**
   * 渲染进程启动时取词条表。
   *
   * 走 IPC 而不是让渲染进程自己读盘：渲染进程在 Chromium 沙箱里没有 fs，
   * 而且打包后插件可能躺在 asar 里 —— 只有主进程能读。
   */
  ipcMain.handle(HOST_CHANNELS.getI18n, (): I18nPayload => getI18nPayload())

  /**
   * 「设置 -> 插件」要的清单：装了哪些插件。
   *
   * 和 host:get-plugin-views 是两件事：那个回答「界面上有哪些视图」，这个回答
   * 「磁盘上有哪些插件」。纯数据插件（语言包）只有后者认得，而设置界面必须
   * 把它们列出来 —— 用户装了个语言包却在插件列表里找不到，那是最容易踩的坑。
   */
  ipcMain.handle(HOST_CHANNELS.getPlugins, async (): Promise<PluginDescriptor[]> => {
    try {
      return await invokeHost<PluginDescriptor[]>('plugins', 'list', [])
    } catch (error) {
      // 清单的唯一来源是 host。读不到就给空列表，而不是拿一份可能过期的镜像顶上
      logger.error('Failed to read the plugin list through host', { error })
      return []
    }
  })

  /**
   * 已启用插件的浏览器半 bundle。
   *
   * 只返回纯数据；绝对路径仅用于开发期的 Vite `/@fs/`，生产环境会换成
   * app 协议（见 docs/architecture/plugin-ui-bundles.md）。
   */
  ipcMain.handle(HOST_CHANNELS.getClientBundles, async (): Promise<ClientBundleDescriptor[]> => {
    try {
      return await invokeHost<ClientBundleDescriptor[]>('plugins', 'clientBundles', [])
    } catch (error) {
      logger.error('Failed to read the client bundles through host', { error })
      return []
    }
  })

  /**
   * 启用 / 禁用插件。
   *
   * 「禁用」的效果**立刻可见**，因为它落在渲染进程侧：被禁用的插件，它的视图
   * 会从工具区消失（见 renderer 的 plugin.store）。宿主这边记状态并**落盘**
   * （见 plugin-host/preference.ts），重启后仍然有效。
   *
   * 刻意**不做**的一件事：不重建窗口。禁用是高频的试错操作，每次都重建窗口会
   * 丢掉编辑器里未保存的内容 —— 而语言切换之所以能那样做，是因为它低频且真的
   * 无法热更新。
   */
  ipcMain.handle(
    HOST_CHANNELS.setPluginEnabled,
    async (event, pluginId: string, enabled: boolean, options: unknown): Promise<boolean> => {
      /**
       * 第三方插件启用前先问一次信任。
       *
       * 内置插件不走这一问：它们随宿主分发，用户没有「装不装」的选择。第三方代码
       * 拥有完整 Node 权限（D6），装进来只代表「有了」，启用才是信任决定。
       *
       * 「是不是第三方」只有 host 的清单知道；读不到清单时**不问**（与搬迁前
       * 「清单里找不到这个 id」同一条行为），因为那时启用也不会成功。
       */
      const record = await findPlugin(pluginId)
      if (enabled && record && !record.builtin) {
        const ok = await isActionConfirmed(event.sender, options, {
          ...CONFIRM_SPECS.enableThirdPartyPlugin,
          params: { name: record.name }
        })
        if (!ok) {
          pluginLogger.info('Third-party plugin enable cancelled by the user', { pluginId })
          return false
        }
      }

      /**
       * 启用状态由 host 持有并落盘（和 plugin list / bundles 同一份清单）。
       * shell 这份镜像仍然要更新：视图过滤与 i18n 用的是 `getDisabledPlugins()`，
       * 它读的是 `plugin-host/preference.ts` 的内存镜像。两边写同一个文件、同一个
       * 值，重复这一步换来的是「视图列表不用等 host 回包也能立刻正确」。
       */
      try {
        await invokeHost('plugins', 'setEnabled', [pluginId, enabled])
      } catch (error) {
        logger.warn('host plugins.setEnabled failed, falling back to the shell preference', {
          error
        })
      }

      setPluginEnabled(pluginId, enabled)

      // 供应商插件被禁用时，把它还在跑的 SSE 全部取消；否则用户以为停用了，
      // 后台仍然在读流。
      if (!enabled && pluginId === AI_PROVIDER_PLUGIN_ID) shutdownAiProviderIPC()

      pluginLogger.info(`Plugin ${enabled ? 'enabled' : 'disabled'}`, { pluginId })

      /**
       * 广播给**所有**窗口。
       *
       * 必要性来自窗口模型：设置窗口和主窗口是两个渲染进程，各自持有一份 zustand
       * store。在设置窗口里取消勾选、主窗口那边不会有任何变化 —— 除非有人告诉它。
       * pushEventToRenderer 是既有的宿主 -> 全窗口广播通道，这里正好是它的用途。
       */
      pushEventToRenderer(HOST_EVENT_CHANNELS.pluginEnabledChanged, pluginId, enabled)
      return true
    }
  )

  /** 当前被禁用的插件。渲染进程启动时取一次，用来过滤视图列表 */
  ipcMain.handle(HOST_CHANNELS.getDisabledPlugins, async (): Promise<string[]> => {
    try {
      return await invokeHost<string[]>('plugins', 'disabled', [])
    } catch (error) {
      logger.warn('host plugins.disabled failed, falling back to the shell preference', { error })
      return getDisabledPlugins()
    }
  })

  /**
   * 从本地文件夹安装插件。
   *
   * shell 只负责选目录（host 没有窗口），实际复制 / 校验 / 落盘 / 重扫都在 host。
   * 装进来默认禁用，启用时还要过 `enableThirdPartyPlugin` 那道信任确认。
   *
   * 装完要重扫 shell 自己的视图 / 设置页 / 语言包注册表 —— 它们仍在 shell：
   * 新插件的视图与设置页要立刻出现在界面上，不能等重启。
   */
  ipcMain.handle(HOST_CHANNELS.installPlugin, async (event): Promise<PluginInstallResult> => {
    const t = createMainTranslator()
    const parent = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: t('host.plugins.install.title'),
      properties: ['openDirectory']
    }

    const picked = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)

    const source = picked.canceled ? undefined : picked.filePaths[0]
    if (!source) return { ok: false, reason: 'cancelled' }

    try {
      const result = await invokeHost<PluginInstallResult>('plugins', 'install', [source])
      if (result.ok) notifyPluginCatalogChanged()
      return result
    } catch (error) {
      logger.warn('host plugins.install failed', { error })
      return { ok: false, reason: 'unreadable' }
    }
  })

  /**
   * 卸载一个第三方插件。
   *
   * 内置插件在 host 里也会被拒；这里提前挡一次是为了先给出「内置插件不可卸载」，
   * 而不是让用户回答一个注定失败的确认框。
   */
  ipcMain.handle(
    HOST_CHANNELS.removePlugin,
    async (event, pluginId: unknown): Promise<PluginRemoveResult> => {
      const id = String(pluginId ?? '')
      if (id.length === 0) return { ok: false, reason: 'not-found' }

      const record = await findPlugin(id)
      if (record?.builtin) return { ok: false, reason: 'builtin' }

      const confirmed = await isActionConfirmed(event.sender, undefined, {
        ...CONFIRM_SPECS.uninstallPlugin,
        params: { name: record?.name ?? id }
      })
      if (!confirmed) return { ok: false, reason: 'cancelled' }

      try {
        const result = await invokeHost<PluginRemoveResult>('plugins', 'remove', [id])
        if (result.ok) notifyPluginCatalogChanged()
        return result
      } catch (error) {
        logger.warn('host plugins.remove failed', { error })
        return { ok: false, reason: 'unreadable' }
      }
    }
  )

  /** 当前主题的完整载荷。渲染进程启动后拉一次，用来填设置页的主题列表 */
  ipcMain.handle(HOST_CHANNELS.getTheme, (): ThemePayload => getThemePayload())

  /**
   * 「设置 -> 外观与行为 -> 外观」提交新的主题。
   *
   * 载荷只是一个**主题 id**，当作不可信输入收：主题存不存在由注册表回答
   * （见 setThemePreference），拿不到就拒绝并保持原样 —— 而不是把脏值写进偏好，
   * 让下次启动还要再回落一次。
   *
   * 与 set-locale 的关键差别：这里不重建窗口、不确认。换主题不需要重建（词条表在
   * 首帧前就固定了），也就不会丢掉未保存的内容。
   */
  ipcMain.handle(HOST_CHANNELS.setTheme, (_e, payload: unknown): boolean => {
    const preference = normalizeAppearancePreference(payload)
    /**
     * `followSystem` 刻意**不**从载荷里取：它当前恒为 false（设置页把这一项摆成
     * 了灰的），渲染进程没有能力打开它。真打开时，那条路应该像切语言一样走
     * 主进程自己的判断，而不是让渲染进程随手指定。
     */
    return setThemePreference(preference.theme, getAppearancePreference().followSystem)
  })

  /** 渲染进程/插件请求切换语言；真正生效靠重建窗口，所以走和菜单同一条路径 */
  ipcMain.handle(HOST_CHANNELS.setLocale, async (_e, locale: LocaleId): Promise<void> => {
    await applyLocaleSwitch(locale)
  })
  // 渲染进程 -> 宿主 的事件总线
  ipcMain.on(HOST_CHANNELS.eventEmit, (_e, channel: string, ...args: unknown[]) => {
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
  ipcMain.on(HOST_CHANNELS.editorChange, (_e, filePath: string, content: string) => {
    /**
     * debug 级别：这条消息**每次按键**都会来，info 级别会让日志文件被逐键
     * 记录冲掉。要排查它时把 NIDE_LOG_LEVEL 设成 debug。
     */
    logger.debug('Editor content changed', { filePath, chars: content.length })
  })

  // 插件重载（占位，等插件后端接上再实现）
  ipcMain.handle(HOST_CHANNELS.reloadPlugin, (_e, pluginId: string) => {
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
  ipcMain.handle(HOST_CHANNELS.showStripeMenu, (event, showTitles: boolean): Promise<boolean> => {
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

/**
 * 插件目录变了（安装 / 卸载）之后的通知。
 *
 * host 在 install / remove 里已经重扫过目录（视图、设置页、语言包都在那边），所以
 * 这里只需要做两件事：刷新 shell 自己的禁用集合镜像（装进来的插件默认禁用），
 * 再用既有的 `plugin:enabled-changed` 广播叫所有窗口重拉一次 —— 主窗口重拉视图，
 * 设置窗口重拉设置树。它只是「该刷新了」的信号，不携带语义。
 */
function notifyPluginCatalogChanged(): void {
  reloadPluginPreference()
  pushEventToRenderer(HOST_EVENT_CHANNELS.pluginEnabledChanged, '', false)
}

/**
 * 从 host 的清单里找一条插件记录；读不到时给 null。
 *
 * 「是不是第三方」只由 host 的清单回答 —— shell 不再自己扫目录，所以这里没有第二
 * 份名单可查。读不到时调用方按「不知道」处理（不弹信任确认、让 host 自己去拒绝）。
 */
async function findPlugin(pluginId: string): Promise<PluginDescriptor | null> {
  try {
    const plugins = await invokeHost<PluginDescriptor[]>('plugins', 'list', [])
    return plugins.find((plugin) => plugin.id === pluginId) ?? null
  } catch (error) {
    logger.warn('Failed to look up a plugin through host', { pluginId, error })
    return null
  }
}

/** 宿主 -> 渲染进程：推送事件 */
export function pushEventToRenderer(channel: string, ...args: unknown[]): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue
    wc.send(HOST_CHANNELS.event, channel, ...args)
  }
}

/** 宿主 -> 渲染进程：通知文件已变化 */
export function notifyFileChanged(filePath: string, content: string): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue
    wc.send(HOST_CHANNELS.fileChanged, filePath, content)
  }
}

/** 宿主 -> 渲染进程：请求展示 Diff */
export function requestShowDiff(original: string, modified: string): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue
    wc.send(HOST_CHANNELS.showDiff, original, modified)
  }
}
