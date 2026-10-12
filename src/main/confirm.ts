import { randomUUID } from 'node:crypto'
import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { CONFIRM_CHANNELS, confirmRequested, parseConfirmResponse } from '@shared/confirm'
import type { ConfirmRequest } from '@shared/confirm'
import type { HostMessageKey, MessageParams } from '@shared/i18n'
import { createMainTranslator } from './i18n'
import { loggerFor } from './logger'

const logger = loggerFor('confirm')

/**
 * 行为级二次确认的门。
 *
 * 破坏性动作的出口在主进程（IPC 通道：删除、关项目、换项目、退出、重启），所以
 * 确认也问在这里 —— 谁发起都算数。渲染进程那一侧只有一个通用宿主
 * （`renderer/ui/ConfirmHost`）：它把请求画成 `ConfirmDialog`，再把回答原样送回来。
 *
 * ## 为什么不用 dialog.showMessageBox
 *
 * 原生对话框是系统画的：宿主所有窗口都是无边框 + 自绘标题栏（见 window.ts 的
 * frameOptions），一个原生框插进来会和旁边的界面完全两套东西。而且它是**模态**的，
 * 会阻塞发起那一侧的调用栈 —— 这几条确认的时机都在「用户刚点完某个入口」之后，
 * 主进程不该在这里被卡住。
 *
 * ## 问不出去就不做
 *
 * 没有任何窗口能画浮层时（发起方已经没了、渲染进程崩了），`isActionConfirmed`
 * 返回 false：破坏性动作宁可什么都不发生，也不能「问不成就默认同意」。
 *
 * 唯一的例外在退出那条路上，见 lifecycle.ts 的说明。
 *
 * ## 已知边界：跳过那一侧是敞开的
 *
 * `{ confirm: false }` 对渲染进程是开放的，所以插件也能写它 —— 于是「问不问」在
 * 这一侧是**可以自己声明**的。这是刻意的取舍：这条豁免必须存在（设置窗口的
 * 「立即重启」正是靠它避免问两遍），而主进程现在还认不出调用方是谁（插件没有
 * 后端通道，所有调用都来自同一个渲染进程）。等到插件后端接上、IPC 能分辨调用方，
 * 这里应当按插件权限收口（见 plugin-host/permission.ts）。
 */

/**
 * 一次询问要说的话。只写**词条 key**，文案到问的那一刻才用当前语言翻出来 ——
 * 挂在这里的字符串会跟着进程活到下一次切语言之后。
 */
export interface ConfirmSpec {
  titleKey: HostMessageKey
  messageKey: HostMessageKey
  confirmKey: HostMessageKey
  /** `{name}` 这类占位符的值。缺了会原样留在文案里，一眼看得见 */
  params?: MessageParams
  danger?: boolean
}

/**
 * 宿主**所有**需要二次确认的动作，一句话一条。
 *
 * 收成一张表的理由和「窗口种类登记在 WINDOW_TYPES」一样：这条策略要能被一眼看完、
 * 加动作时改一处。表里没有的动作就是不问的动作，此处的取舍是明示的。
 *
 * 加了条目还要在它的出口处过一道 `isActionConfirmed` —— 表本身不会拦住任何东西。
 */
export const CONFIRM_SPECS = {
  /** 关闭当前项目：主窗口被拆掉，换回欢迎窗口。项目记录留着，下次启动照样打开 */
  closeProject: {
    titleKey: 'host.menu.file.closeProject.confirm.title',
    messageKey: 'host.menu.file.closeProject.confirm.message',
    confirmKey: 'host.menu.file.closeProject'
  },
  /**
   * 换项目：主窗口原地重建，未保存的编辑内容归零。
   *
   * `{name}` 由调用方给（它才知道要打开哪一个），见 project.ipc.ts。
   */
  switchProject: {
    titleKey: 'host.project.switch.confirm.title',
    messageKey: 'host.project.switch.confirm.message',
    confirmKey: 'host.project.switch.confirm.action'
  },
  /** 退出应用：所有窗口都会关掉 */
  quit: {
    titleKey: 'host.menu.file.quit.confirm.title',
    messageKey: 'host.menu.file.quit.confirm.message',
    confirmKey: 'host.menu.file.quit',
    danger: true
  },
  /**
   * 关闭根窗口（主窗口 / 欢迎窗口）。
   *
   * 关它和退出的分量一样：Windows / Linux 上最后一个窗口关掉，进程就结束了。
   * 设置窗口不在这条路上 —— 它是附属窗口，关掉不损失任何东西（见 lifecycle.ts）。
   */
  closeWindow: {
    titleKey: 'host.window.close.confirm.title',
    messageKey: 'host.window.close.confirm.message',
    confirmKey: 'host.window.close.confirm.action',
    danger: true
  },
  /**
   * 重启应用：重建根窗口，未保存的编辑内容归零。
   *
   * 设置窗口与欢迎窗口的「需要重启」提示**已经**问过用户了（见 RestartDialog），
   * 所以那两处显式跳过这一问。
   */
  restart: {
    titleKey: 'host.restart.confirm.title',
    messageKey: 'host.restart.confirm.message',
    confirmKey: 'host.restart.confirm.action'
  },
  /** 删除一个文件。宿主唯一不可撤销的写盘动作 */
  deleteFile: {
    titleKey: 'host.explorer.delete.title.file',
    messageKey: 'host.explorer.delete.message.file',
    confirmKey: 'host.explorer.delete.confirm',
    danger: true
  },
  /**
   * 删除一个文件夹（连同里面的东西）。
   *
   * 与删除文件分开成两条，是因为文案必须说得更重：它带走的是一整棵子树。用哪一条
   * 由主进程读了磁盘再定（见 project.ipc.ts 与 entryKindAt）。
   */
  deleteFolder: {
    titleKey: 'host.explorer.delete.title.folder',
    messageKey: 'host.explorer.delete.message.folder',
    confirmKey: 'host.explorer.delete.confirm',
    danger: true
  }
} as const satisfies Record<string, ConfirmSpec>

interface PendingConfirm {
  /**
   * 发起询问的那个渲染进程。
   *
   * 只有它能回答：别的窗口（或渲染进程里的插件）拿着一个猜来的编号作答，等于
   * 替用户按了「确定」。
   */
  senderId: number
  settle: (confirmed: boolean) => void
}

/** 问出去还没有回答的那些询问，按编号索引 */
const pending = new Map<string, PendingConfirm>()

/**
 * 这个窗口还能不能画浮层、还能不能把回答送回来。
 *
 * 渲染进程已经不在了（崩了、已经销毁）时不能问：回答永远不会来，而调用方会一直
 * 等下去。关窗那道门尤其不能这么卡住 —— 那会让窗口连「关掉」这个唯一的出口都没有。
 */
export function canAskIn(window: BrowserWindow): boolean {
  if (window.isDestroyed()) return false

  const { webContents } = window
  return !webContents.isDestroyed() && !webContents.isCrashed()
}

/**
 * 问一次，等回答。
 *
 * 调用方必须先用 `canAskIn` 确认过这个窗口问得出去。窗口在等待期间消失（被销毁、
 * 渲染进程崩掉）时按**拒绝**结束：那一问没有答案，而破坏性动作的默认答案是不做。
 */
export function askConfirmation(window: BrowserWindow, spec: ConfirmSpec): Promise<boolean> {
  const t = createMainTranslator()
  const id = randomUUID()
  const { webContents } = window

  const request: ConfirmRequest = {
    id,
    title: t(spec.titleKey),
    message: t(spec.messageKey, spec.params),
    confirmLabel: t(spec.confirmKey),
    cancelLabel: t('host.dialog.cancel'),
    danger: spec.danger ?? false
  }

  logger.debug('Asking for confirmation', { id, titleKey: spec.titleKey })

  return new Promise<boolean>((resolve) => {
    /**
     * 结束这一问。
     *
     * 「先从表里摘掉」这一步是幂等的关口：窗口消失与用户回答可能前后脚到，第二个
     * 到达的按过期处理，只会 resolve 一次。
     */
    const settle = (confirmed: boolean): void => {
      if (!pending.delete(id)) return

      // 已经销毁的对象连摘监听都会抛（isDestroyed 本身是安全的），而这一问的结论
      // 不受影响：监听器跟着对象一起没了，没有泄漏
      if (!window.isDestroyed()) window.off('closed', onLost)
      if (!webContents.isDestroyed()) webContents.off('destroyed', onLost)

      resolve(confirmed)
    }

    /** 窗口没了 = 没人能回答。按拒绝处理，并留下一条痕迹 */
    const onLost = (): void => {
      logger.warn('The window being asked went away; treating it as a refusal', { id })
      settle(false)
    }

    pending.set(id, { senderId: webContents.id, settle })
    window.on('closed', onLost)
    webContents.on('destroyed', onLost)

    try {
      webContents.send(CONFIRM_CHANNELS.request, request)
    } catch (error) {
      // 发送失败说明这一问根本没送到（上面的两道监听未必都来得及触发）
      logger.warn('Failed to send a confirmation request', { id, error })
      settle(false)
    }
  })
}

/**
 * 可确认动作的统一出口：该问就问，用户拒了就别做。
 *
 * 每个挂表动作的 IPC 出口都长这样：
 *
 * ```ts
 * if (!(await isActionConfirmed(event.sender, options, CONFIRM_SPECS.xxx))) return
 * ```
 *
 * @param initiator 发起这次调用的渲染进程。问就问到它那个窗口上
 * @param options 调用方传的 ConfirmOptions。`{ confirm: false }` 表示已经问过了
 */
export async function isActionConfirmed(
  initiator: WebContents | null,
  options: unknown,
  spec: ConfirmSpec
): Promise<boolean> {
  if (!confirmRequested(options)) {
    logger.debug('Confirmation skipped at the caller request', { titleKey: spec.titleKey })
    return true
  }

  const window = initiator ? BrowserWindow.fromWebContents(initiator) : null
  if (!window || !canAskIn(window)) {
    logger.warn('Refused a confirmable action with no window to ask in', {
      titleKey: spec.titleKey
    })
    return false
  }

  return askConfirmation(window, spec)
}

/**
 * 回答通道。
 *
 * 只做三件事：认形状、查编号、验发起方 —— 然后原样把布尔值交给等着的那一问。
 */
export function registerConfirmIPC(): void {
  ipcMain.on(CONFIRM_CHANNELS.respond, (event, payload: unknown): void => {
    const answer = parseConfirmResponse(payload)
    if (!answer) {
      logger.warn('Received a malformed confirmation answer')
      return
    }

    const entry = pending.get(answer.id)
    // 没登记过的编号不是错误：可能是重复回答，也可能是这一问刚刚被别的路径结束掉
    if (!entry) return

    if (entry.senderId !== event.sender.id) {
      logger.warn('Ignored a confirmation answer from another window', { id: answer.id })
      return
    }

    entry.settle(answer.confirmed)
  })
}
