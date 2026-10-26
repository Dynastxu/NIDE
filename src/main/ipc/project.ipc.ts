import fs from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import {
  PROJECT_CHANNELS,
  PROJECT_CONFIG_CHANNELS,
  PROJECT_FILE_CHANNELS,
  PROJECT_GALLERY_CHANNELS,
  PROJECT_OVERVIEW_CHANNELS,
  isProjectSwitch,
  projectNameFromPath
} from '@nide/contracts/project'
import type {
  DeleteEntryRequest,
  DeleteEntryResult,
  ProjectListItem,
  ProjectOpenResult,
  ProjectPickMode
} from '@nide/contracts/project'
import { CONFIRM_SPECS, isActionConfirmed, type ConfirmSpec } from '../confirm'
import { createMainTranslator } from '../i18n'
import { loggerFor } from '../logger'
import { closeProject, forgetProject, listProjects, openProject } from '../host/project'
import { invokeHost } from '../host/process'
import { activateMainWindow, getBoundProjectPath, returnToWelcomeWindow } from '../window'

const logger = loggerFor('project')

/**
 * 项目通道。
 *
 * 这一层现在只剩三件事：
 *
 * 1. **目录对话框与窗口切换**：只有 shell 能做（host 没有窗口）；
 * 2. **二次确认**：删除、换项目、关闭项目那几问仍然问在 shell；
 * 3. **转发**：`projects.json` 的唯一实现在 host（见 host/project.ts），文件 / 章节 /
 *    图鉴 / 概述 / 配置也一样。这里保留同一批 IPC 通道，是为了 preload 的 host 直连
 *    port 失败时仍有一条路可走 —— 两条通道最终都进 host 的同一张 `RpcRegistry`，
 *    不存在第二份实现。
 *
 * 换项目的顺序是「先问、后写、最后切窗」：确认 → `project.open`（host 落盘并把当前
 * 项目定下来）→ `activateMainWindow()`（新窗口带着这条记录建出来）。
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
  let recent: ProjectListItem | undefined
  try {
    recent = (await listProjects()).find((project) => !project.missing)
  } catch (error) {
    // 列表读不到只影响对话框从哪儿开始，不该让「选个目录」这件事整个失败
    logger.warn('Failed to read the project list for the dialog default path', { error })
  }
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
 * 让 host 初始化一个新项目（默认配置、内容目录、默认图鉴与概述预设）。
 *
 * 初始化必须在**开窗之前**完成：主窗口一打开，文件树与项目配置的第一次读取就可能
 * 落在一个还没有 `.nide` 的项目上。host 那边不抛（失败降级成日志），这里再兜一层：
 * 初始化失败不该把「打开项目」变成一次失败 —— 之后读配置时 `.nide` 还会被重建，
 * 丢的只是默认图鉴与概述预设。
 */
async function initializeProject(root: string): Promise<void> {
  try {
    await invokeHost('config', 'initialize', [root])
  } catch (error) {
    logger.warn('Failed to initialize the project directory through host', { error })
  }
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
 *
 * `create` 是「这个目录是刚新建的项目吗」，只有它为真时才**初始化** `.nide`
 * （建配置目录与内容目录）。这条区别是刻意的：初始化会往项目里写东西，而在一个
 * 已有项目上替用户建目录是替他做决定 —— 打开别人的项目、打开一个只用来看稿的
 * 文件夹，都不该长出宿主自己的目录来。
 *
 * ## 换项目要先问一句
 *
 * 换项目会把主窗口**原地重建**（见 window.ts 的 activateMainWindow），当前窗口的
 * 一切跟着归零：打开的文件标签页、编辑器里未保存的改动、文件树的展开状态。所以
 * 离开一个**已经打开的项目**之前先过行为级二次确认。
 *
 * 判据用的是**主窗口绑定的那个项目**（`getBoundProjectPath()`），不是再问一次 host：
 * 这个窗口就是即将被重建的那一个，它绑着谁才是「要丢掉哪些东西」的答案。
 *
 * @param dirPath 要打开的项目目录路径
 * @param create 是否为新建项目。为真时会让 host 初始化 `.nide` 目录结构
 * @param initiator 发起这次打开的渲染进程。确认框问到它那个窗口上
 * @param options 调用方传上来的确认选项。`{ confirm: false }` 时跳过换项目的二次确认
 */
async function activate(
  dirPath: string,
  create: boolean,
  initiator: WebContents,
  options: unknown
): Promise<ProjectOpenResult> {
  if (isProjectSwitch(getBoundProjectPath(), dirPath, caseInsensitivePaths())) {
    const spec: ConfirmSpec = {
      ...CONFIRM_SPECS.switchProject,
      // 目标项目的显示名由路径推导，与标题栏、项目下拉用的是同一个函数
      params: { name: projectNameFromPath(dirPath) }
    }

    if (!(await isActionConfirmed(initiator, options, spec))) {
      logger.info('Project switch cancelled by the user')
      return { ok: false, reason: 'cancelled' }
    }
  }

  let result: ProjectOpenResult
  try {
    result = await openProject(dirPath)
  } catch (error) {
    // host 不可达。这里不能装作「目录不存在」—— 用户看到的原因必须是真的那一个
    logger.error('Failed to open a project through host', { error })
    return { ok: false, reason: 'unreadable', path: dirPath }
  }

  if (!result.ok) {
    logger.warn('Failed to open a project', { reason: result.reason })
    return result
  }

  if (create) await initializeProject(result.project.path)

  activateMainWindow(result.project)
  return result
}

/**
 * 读项目列表；host 不可达时回落成空列表。
 *
 * 为什么不抛：这几条通道是 preload 直连 host 失败后的**回退**，走到这里通常意味着
 * host 本身有问题。空列表会让界面说「还没有打开过任何文件夹」，但一个 rejected
 * promise 在欢迎窗口里是没人接的（列表会永远停在「加载中」），那比一句不准确的话
 * 更难解释。真因记在日志里。
 */
async function listProjectsOrEmpty(): Promise<ProjectListItem[]> {
  try {
    return await listProjects()
  } catch (error) {
    logger.error('Failed to read the project list through host', { error })
    return []
  }
}

export function registerProjectIPC(): void {
  ipcMain.handle(PROJECT_CHANNELS.list, listProjectsOrEmpty)

  ipcMain.handle(
    PROJECT_CHANNELS.open,
    (event, dirPath: unknown, options: unknown): Promise<ProjectOpenResult> => {
      if (typeof dirPath !== 'string' || dirPath.length === 0) {
        logger.warn('Received an invalid project path')
        return Promise.resolve({ ok: false, reason: 'missing' })
      }
      // 打开列表里的一条 = 打开一个已有项目，**不初始化**（见 activate）
      return activate(dirPath, false, event.sender, options)
    }
  )

  ipcMain.handle(
    PROJECT_CHANNELS.pick,
    async (event, mode: unknown, options: unknown): Promise<ProjectOpenResult> => {
      const kind: ProjectPickMode = mode === 'new' ? 'new' : 'open'
      const parent = BrowserWindow.fromWebContents(event.sender)

      const dirPath = await pickDirectory(parent, kind)
      // 取消不是错误：界面不该因此弹任何提示，只是什么都没发生
      if (!dirPath) return { ok: false, reason: 'cancelled' }

      // 「新建项目」= 初始化项目结构；「打开」= 读它本来的样子
      return activate(dirPath, kind === 'new', event.sender, options)
    }
  )

  /**
   * 从列表里移除一条记录。
   *
   * host 直接回**移除之后**的列表：界面不必再发一次 list，也就不会出现「删了但界面
   * 还是旧的」那一帧。host 不可达时把同样的空列表兜底交给界面（原因进日志）。
   */
  ipcMain.handle(
    PROJECT_CHANNELS.remove,
    async (_event, dirPath: unknown): Promise<ProjectListItem[]> => {
      if (typeof dirPath !== 'string' || dirPath.length === 0) {
        logger.warn('Received an invalid project path to remove')
        return listProjectsOrEmpty()
      }

      try {
        return await forgetProject(dirPath)
      } catch (error) {
        logger.error('Failed to remove a project through host', { error })
        return []
      }
    }
  )

  /**
   * 关闭项目（标题栏「文件 -> 关闭项目」）—— 回退到欢迎窗口。
   *
   * 记录留在列表里，`lastOpened` 也不动：下一次启动仍然打开它。这里只是让这一次
   * 会话回到「没有项目」的状态。
   *
   * 会丢掉当前窗口的一切，所以先过行为级二次确认；确认之后这个窗口马上就会被拆掉，
   * 所以回执没有接收方，用单向 on 而不是 handle。
   */
  ipcMain.on(PROJECT_CHANNELS.close, (event, options: unknown): void => {
    void (async () => {
      if (!(await isActionConfirmed(event.sender, options, CONFIRM_SPECS.closeProject))) return

      try {
        await closeProject()
      } catch (error) {
        // host 那边没关成就别换窗口：换过去之后 host 仍认为有个项目开着，之后所有
        // 「当前项目」的判断都是错的。停在这儿，让用户再点一次。
        logger.error('Failed to close the project through host', { error })
        return
      }

      returnToWelcomeWindow()
    })()
  })

  // ============ 转发到 host ============
  //
  // preload 正常情况下走 renderer ↔ host 的直连 port；这些 handler 是它失败时的
  // 回退路径。两条路都进 host 的同一张 RpcRegistry，所以参数与结果不需要再翻译。

  /** 一个 `ipcMain.handle` 的转发器：把 event 之后的参数原样交给 host */
  const forward = (namespace: string, method: string) => {
    return (_event: unknown, ...args: unknown[]): Promise<unknown> =>
      invokeHost(namespace, method, args)
  }

  ipcMain.handle(PROJECT_FILE_CHANNELS.readDir, forward('files', 'readDir'))
  ipcMain.handle(PROJECT_FILE_CHANNELS.readFile, forward('files', 'readFile'))
  ipcMain.handle(PROJECT_FILE_CHANNELS.readChapters, forward('files', 'readChapters'))
  ipcMain.handle(PROJECT_FILE_CHANNELS.readForeshadowing, forward('files', 'readForeshadowing'))
  ipcMain.handle(PROJECT_FILE_CHANNELS.writeFile, forward('files', 'writeFile'))
  ipcMain.handle(PROJECT_FILE_CHANNELS.createEntry, forward('files', 'createEntry'))
  ipcMain.handle(PROJECT_FILE_CHANNELS.renameEntry, forward('files', 'renameEntry'))

  ipcMain.handle(PROJECT_GALLERY_CHANNELS.readGalleries, forward('gallery', 'read'))
  ipcMain.handle(PROJECT_GALLERY_CHANNELS.createGallery, forward('gallery', 'create'))
  ipcMain.handle(PROJECT_GALLERY_CHANNELS.updateRegistry, forward('gallery', 'updateRegistry'))

  ipcMain.handle(PROJECT_OVERVIEW_CHANNELS.readOverview, forward('overview', 'read'))
  ipcMain.handle(PROJECT_OVERVIEW_CHANNELS.setRole, forward('overview', 'setRole'))

  ipcMain.handle(PROJECT_CONFIG_CHANNELS.read, forward('config', 'read'))
  ipcMain.handle(PROJECT_CONFIG_CHANNELS.update, forward('config', 'update'))

  /**
   * 删除前的二次确认 —— 为 preload 的 host 写路径与上面的回退路径共用。
   *
   * host 没有窗口、问不出浮层，所以「问」永远在 shell：preload 先调这一条，用户
   * 同意后再调 host；旧 `deleteEntry` 通道也会自己问一遍（回退时 preload 传
   * `{ confirm: false }`，避免问两次）。
   */
  ipcMain.handle(
    PROJECT_FILE_CHANNELS.confirmDelete,
    async (event, request: unknown, options: unknown): Promise<boolean> => {
      const parsed = parseDeleteRequest(request)
      if (!parsed) {
        logger.warn('Rejected a malformed delete confirmation request')
        return false
      }

      return confirmDelete(event.sender, parsed, options)
    }
  )

  /**
   * 删除一个条目。目录连同里面的东西一起删。
   *
   * 只收一个路径：删多深没有参数可调，**根自己不能删**这条在 host 里兜着 ——
   * 树上的根那一行同样可以右键，而界面上的入口不该是唯一一道防线。
   *
   * 这是唯一不可撤销的写盘动作，所以二次确认**问在这里**（行为级）：无论谁发起
   * 删除都经过这条通道，界面那一侧因此不再自己弹框（见 ExplorerView）。用户拒了
   * 就回一条 `cancelled` —— 它不是失败，界面不该因此提示什么。
   */
  ipcMain.handle(
    PROJECT_FILE_CHANNELS.deleteEntry,
    async (event, request: unknown, options: unknown): Promise<DeleteEntryResult> => {
      const parsed = parseDeleteRequest(request)
      if (!parsed) {
        logger.warn('Rejected a malformed delete request')
        return { ok: false, reason: 'unreadable' }
      }

      if (!(await confirmDelete(event.sender, parsed, options))) {
        return { ok: false, reason: 'cancelled' }
      }

      return invokeHost<DeleteEntryResult>('files', 'deleteEntry', [parsed])
    }
  )
}

/**
 * 这个路径上是什么（文件 / 目录），问不出来时给 null。
 *
 * 唯一的用途是给二次确认框挑一句话：删目录带走的是一整棵子树，那句话必须比删一个
 * 文件说得更重。它**不参与任何校验**，读到的结论也只影响文案：host 的删除自己在
 * 执行前会重新判一次类型与边界。
 */
async function entryKindAt(targetPath: string): Promise<'file' | 'directory' | null> {
  try {
    const stats = await fs.lstat(targetPath)
    if (stats.isSymbolicLink()) return null
    if (stats.isDirectory()) return 'directory'
    if (stats.isFile()) return 'file'
    return null
  } catch {
    return null
  }
}

/** 删除前的确认。目录与文件问的话不一样（见 CONFIRM_SPECS 的两条 delete） */
async function confirmDelete(
  initiator: WebContents,
  request: DeleteEntryRequest,
  options: unknown
): Promise<boolean> {
  const kind = await entryKindAt(request.targetPath)
  const spec = kind === 'directory' ? CONFIRM_SPECS.deleteFolder : CONFIRM_SPECS.deleteFile

  return isActionConfirmed(initiator, options, {
    ...spec,
    params: { name: path.basename(request.targetPath) }
  })
}

/**
 * 校验一个删除请求的形状。只该有一个非空字符串路径。
 *
 * IPC 载荷是渲染进程给的，形状完全不可信；host 还会再判一次，但在这里先挡掉明显的
 * 坏载荷，确认框就不会为一个空路径弹出来。
 */
function parseDeleteRequest(request: unknown): DeleteEntryRequest | null {
  if (!request || typeof request !== 'object') return null

  const { targetPath } = request as Partial<DeleteEntryRequest>
  if (typeof targetPath !== 'string' || targetPath.length === 0) return null

  return { targetPath }
}

/** 路径比较是否忽略大小写。Windows 的路径不区分大小写 */
function caseInsensitivePaths(): boolean {
  return process.platform === 'win32'
}
