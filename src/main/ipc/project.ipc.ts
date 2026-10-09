import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import {
  PROJECT_CHANNELS,
  PROJECT_FILE_CHANNELS,
  type CreateEntryRequest,
  type CreateEntryResult,
  type DirReadResult,
  type FileReadResult,
  type ProjectOpenResult,
  type ProjectPickMode
} from '@shared/project'
import { createMainTranslator } from '../i18n'
import { loggerFor } from '../logger'
import {
  closeProject,
  forgetProject,
  getCurrentProject,
  getProjectList,
  openProject
} from '../services/project-store'
import {
  createProjectEntry,
  readProjectDir,
  readProjectFile
} from '../services/project-files.service'
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

  /**
   * 项目文件树。
   *
   * 「项目根」在这里取**当前项目**，不由渲染进程传进来 —— 那等于让渲染进程自己
   * 声明自己的活动范围，沙箱边界就只剩下一句口号。渲染进程只能请求路径，能不能
   * 读由主进程对照这份根集合判断（见 project-files.service 的 isInsideProject）。
   *
   * 没有项目时直接拒绝：主窗口只在有项目时才会被创建，走到这里说明请求来自一个
   * 已经被拆掉项目的窗口。
   */
  ipcMain.handle(PROJECT_FILE_CHANNELS.readDir, async (_event, dirPath): Promise<DirReadResult> => {
    const roots = allowedRoots()
    if (roots.length === 0) {
      logger.warn('Rejected a directory read without an open project')
      return { ok: false, reason: 'outside-project' }
    }
    return readProjectDir(String(dirPath ?? ''), {
      roots,
      caseInsensitive: caseInsensitivePaths()
    })
  })

  ipcMain.handle(
    PROJECT_FILE_CHANNELS.readFile,
    async (_event, filePath): Promise<FileReadResult> => {
      const roots = allowedRoots()
      if (roots.length === 0) {
        logger.warn('Rejected a file read without an open project')
        return { ok: false, reason: 'outside-project' }
      }
      return readProjectFile(String(filePath ?? ''), {
        roots,
        caseInsensitive: caseInsensitivePaths()
      })
    }
  )

  /**
   * 新建文件 / 文件夹 —— 宿主**唯一**的写入入口。
   *
   * 目标目录不从渲染进程收，只收「用户右键了谁」+「新名字」：写在哪儿由主进程
   * 从那个被右键的条目推导（目录 -> 内部，文件 -> 同级）。渲染进程因此没有机会
   * 指定一个任意的写入位置。
   *
   * 名字从这里就校验，而不是只靠界面拦：界面是过滤器，主进程才是边界。
   */
  ipcMain.handle(
    PROJECT_FILE_CHANNELS.createEntry,
    async (_event, request: unknown): Promise<CreateEntryResult> => {
      const parsed = parseCreateRequest(request)
      if (!parsed) {
        logger.warn('Rejected a malformed create request')
        return { ok: false, reason: 'invalid-name' }
      }

      const roots = allowedRoots()
      if (roots.length === 0) {
        logger.warn('Rejected a create request without an open project')
        return { ok: false, reason: 'unreadable' }
      }

      return createProjectEntry(parsed, { roots, caseInsensitive: caseInsensitivePaths() })
    }
  )
}

/**
 * 允许访问的根目录集合。
 *
 * 目前只有当前项目一个。**将来会有第二个**：临时文件夹要作为另一个根挂进同一棵树
 * （见 renderer 的 explorer.store）。把它收成一个函数，是为了让「读取」和
 * 「写入」共用同一份范围定义 —— 两处各写一遍的话，迟早出现「能读不能写」或者
 * 更糟的「能写不能读」。
 */
function allowedRoots(): string[] {
  const root = getCurrentProject()?.path
  return root ? [root] : []
}

/** 路径比较是否忽略大小写。Windows 的路径不区分大小写 */
function caseInsensitivePaths(): boolean {
  return process.platform === 'win32'
}

/**
 * 校验一个新建立请求的形状。
 *
 * IPC 的载荷是渲染进程给的，形状完全不可信 —— 这里逐字段确认类型，之后
 * project-files.service 里就可以当它已经是对的。
 */
function parseCreateRequest(request: unknown): CreateEntryRequest | null {
  if (!request || typeof request !== 'object') return null

  const { kind, targetPath, name } = request as Partial<CreateEntryRequest>
  if (kind !== 'file' && kind !== 'directory') return null
  if (typeof targetPath !== 'string' || targetPath.length === 0) return null
  if (typeof name !== 'string') return null

  return { kind, targetPath, name }
}
