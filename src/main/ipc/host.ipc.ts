import { BrowserWindow, Menu, dialog, ipcMain, webContents } from 'electron'
import { uiRegistry } from '../plugin-host/ui-registry'
import { createMainTranslator, getCurrentLocale, getI18nPayload, switchLocale } from '../i18n'
import { manifestNlsRegistry } from '../i18n/manifest-nls'
import { getMainWindow, recreateMainWindow } from '../window'
import type { I18nPayload, LocaleId } from '@shared/i18n'
import type { PluginViewDescriptor } from '@shared/plugin-api'

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

  recreateMainWindow()
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

  /** 渲染进程/插件请求切换语言；真正生效靠重建窗口，所以走和菜单同一条路径 */
  ipcMain.handle('host:set-locale', async (_e, locale: LocaleId): Promise<void> => {
    await applyLocaleSwitch(locale)
  })

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

  /**
   * 工具区按钮条的右键菜单。
   *
   * 原生菜单：勾选状态由 Electron 自己维护，主进程只负责把「最终值」回传给
   * 渲染进程 —— 渲染进程不需要知道菜单长什么样。菜单关闭（点了或点外面取消）
   * 后统一 resolve，取消时值不变，渲染进程直接 set 即可。
   *
   * 语言切换也挂在这里：这是目前宿主**唯一**的原生菜单面，用户已经知道
   * 右键按钮条能出菜单。等有了设置界面应当把它挪过去。
   */
  ipcMain.handle('host:show-stripe-menu', (event, showTitles: boolean): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      const t = createMainTranslator()
      const payload = getI18nPayload()
      let next = showTitles
      let pendingLocale: LocaleId | null = null

      const menu = Menu.buildFromTemplate([
        {
          label: t('host.stripe.menu.showTitles'),
          type: 'checkbox',
          checked: showTitles,
          click: (item) => {
            next = item.checked
          }
        },
        { type: 'separator' },
        {
          label: t('host.stripe.menu.language'),
          submenu: payload.available.map((descriptor) => ({
            label: descriptor.label,
            type: 'radio' as const,
            checked: descriptor.locale === payload.locale,
            click: () => {
              pendingLocale = descriptor.locale
            }
          }))
        }
      ])

      const win = BrowserWindow.fromWebContents(event.sender)
      menu.popup({
        ...(win ? { window: win } : {}),
        callback: () => {
          resolve(next)

          // 关键时序：必须等菜单真正关闭之后再重建窗口。
          // 在 click 回调里直接 destroy() 会把弹出菜单脚下的窗口拆掉，
          // 原生菜单在部分平台上会崩或残留。
          if (pendingLocale !== null) {
            const target = pendingLocale
            setImmediate(() => {
              void applyLocaleSwitch(target)
            })
          }
        }
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
