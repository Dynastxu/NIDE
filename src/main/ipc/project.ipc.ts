import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { PROJECT_CHANNELS, type ProjectOpenResult, type ProjectPickMode } from '@shared/project'
import { createMainTranslator } from '../i18n'
import { loggerFor } from '../logger'
import { closeProject, forgetProject, getProjectList, openProject } from '../services/project-store'
import { activateMainWindow, returnToWelcomeWindow } from '../window'

const logger = loggerFor('project')

/**
 * 项目通道。
 *
 * 「打开过的文件夹」这件事有**两半**：状态与落盘在主进程服务里
 * （src/main/services/project-store.ts），「开哪个窗口」在这里 —— 因为
 * project-store 刻意不认识窗口，而这样切窗口的副作用只有一处，好审。
 *
 * 打开项目的完整动作是：记住目录 -> 开主窗口 -> 拆欢迎窗口。顺序不能反，
 * 理由见 `activate()`。
 */

/**
 * 目录对话框。
 *
 * 「新建项目」与「打开」用的是**同一个对话框**，只有标题和起始目录不同：
 * 系统目录选择器本身就能新建文件夹（Windows / Linux 的对话框带「新建文件夹」
 * 按钮，macOS 由 `createDirectory` 放开），再自绘一个「输入项目名」的表单只会
 * 多一层需要维护的界面，还得自己处理重名与非法字符。
 *
 * `createDirectory` 是 macOS 专有属性，在其余平台上被忽略 —— 留着它，macOS 上
 * 的「新建项目」才真的能新建。
 */
async function pickDirectory(
  parent: BrowserWindow | null,
  mode: ProjectPickMode
): Promise<string | null> {
  const t = createMainTranslator()

  // 起始目录取「最近打开且目录还在」的那个项目：连续开几个同级的项目时，
  // 每次都从同一个地方开始，而系统对话框自己会记住上次的位置
  const recent = getProjectList().find((project) => !project.missing)
  const defaultPath =
    mode === 'new' ? (recent ? path.dirname(recent.path) : app.getPath('documents')) : recent?.path

  const options: Electron.OpenDialogOptions = {
    title: t(
      mode === 'new'
        ? 'host.welcome.projects.dialog.create.title'
        : 'host.welcome.projects.dialog.open.title'
    ),
    buttonLabel: t('host.welcome.projects.dialog.button'),
    properties: ['openDirectory', 'createDirectory'],
    ...(defaultPath ? { defaultPath } : {})
  }

  const picked = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)

  if (picked.canceled || picked.filePaths.length === 0) return null
  return picked.filePaths[0]
}

/**
 * 记住目录并切到主窗口。
 *
 * 「切到主窗口」有两种情形（从欢迎窗口打开 / 在主窗口里换项目），都由
 * `activateMainWindow()` 判断，这里不关心调用方是谁。
 *
 * **先建新窗、再拆旧窗**这个顺序由 window.ts 保证，不能在这里自己拆 —— 反过来的话
 * 拆的那一瞬间可能一个窗口都不剩，触发 window-all-closed，Windows / Linux 上应用
 * 会直接退出。
 */
function activate(dirPath: string): ProjectOpenResult {
  const result = openProject(dirPath)

  if (!result.ok) {
    logger.warn('Failed to open a project', { reason: result.reason })
    return result
  }

  activateMainWindow()
  return result
}

export function registerProjectIPC(): void {
  ipcMain.handle(PROJECT_CHANNELS.list, () => getProjectList())

  ipcMain.handle(PROJECT_CHANNELS.open, (_event, dirPath: unknown): ProjectOpenResult => {
    if (typeof dirPath !== 'string' || dirPath.length === 0) {
      logger.warn('Received an invalid project path')
      return { ok: false, reason: 'missing' }
    }
    return activate(dirPath)
  })

  ipcMain.handle(
    PROJECT_CHANNELS.pick,
    async (event, mode: unknown): Promise<ProjectOpenResult> => {
      const kind: ProjectPickMode = mode === 'new' ? 'new' : 'open'
      const parent = BrowserWindow.fromWebContents(event.sender)

      const dirPath = await pickDirectory(parent, kind)
      // 取消不是错误：界面不该因此弹任何提示，只是什么都没发生
      if (!dirPath) return { ok: false, reason: 'cancelled' }

      return activate(dirPath)
    }
  )

  ipcMain.handle(PROJECT_CHANNELS.remove, (_event, dirPath: unknown) => {
    if (typeof dirPath === 'string' && dirPath.length > 0) forgetProject(dirPath)
    // 直接回新列表：界面不必再发一次 list，也就不会出现「删了但界面还是旧的」那一帧
    return getProjectList()
  })

  /**
   * 关闭项目（标题栏「文件 -> 关闭项目」）—— 回退到欢迎窗口。
   *
   * 记录留在列表里，`lastOpened` 也不动：下一次启动仍然打开它。这里只是让这一次
   * 会话回到「没有项目」的状态。
   *
   * 单向 on 而不是 handle：这个窗口马上就会被拆掉，回执没有接收方。
   */
  ipcMain.on(PROJECT_CHANNELS.close, (): void => {
    closeProject()
    returnToWelcomeWindow()
  })
}
