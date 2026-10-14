import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron'
import {
  PROJECT_CHANNELS,
  PROJECT_CONFIG_CHANNELS,
  PROJECT_FILE_CHANNELS,
  isProjectSwitch,
  projectNameFromPath,
  type CreateEntryRequest,
  type CreateEntryResult,
  type ChapterListResult,
  type DeleteEntryRequest,
  type DeleteEntryResult,
  type DirReadResult,
  type FileReadResult,
  type ProjectConfig,
  type ProjectConfigUpdateResult,
  type ProjectOpenResult,
  type ProjectPickMode,
  type RenameEntryRequest,
  type RenameEntryResult,
  type WriteFileRequest,
  type FileWriteResult
} from '@shared/project'
import { CONFIRM_SPECS, isActionConfirmed, type ConfirmSpec } from '../confirm'
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
  deleteProjectEntry,
  entryKindAt,
  readProjectChapters,
  readProjectDir,
  readProjectFile,
  renameProjectEntry,
  writeProjectFile
} from '../services/project-files.service'
import {
  initializeProjectDirectory,
  loadProjectConfig,
  updateProjectConfig
} from '../services/project-config.service'
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
 *
 * `create` 是「这个目录是刚新建的项目吗」，只有它为真时才**初始化** `.nide`
 * （建配置目录与内容目录）。这条区别是刻意的：初始化会往项目里写东西，而在一个
 * 已有项目上替用户建目录是替他做决定 —— 打开别人的项目、打开一个只用来看稿的
 * 文件夹，都不该长出宿主自己的目录来（`.nide` 被删后的静默重建是另一回事，
 * 见 project-config.service 的 loadProjectConfig）。
 *
 * ## 换项目要先问一句
 *
 * 换项目会把主窗口**原地重建**（见 window.ts 的 activateMainWindow），当前窗口的
 * 一切跟着归零：打开的文件标签页、编辑器里未保存的改动、文件树的展开状态。所以
 * 离开一个**已经打开的项目**之前先过行为级二次确认。
 *
 * 这一问在主进程而不是在项目下拉里：无论谁发起打开（下拉、欢迎窗口、插件、以后的
 * 快捷键）都走这条通道。两个前置条件让「没什么可丢」的打开不会被拦：
 * 从欢迎窗口打开时当前项目是 null，重复打开同一个项目时目标就是当前项目
 * （判据见 shared/project 的 isProjectSwitch）。
 *
 * @param dirPath 要打开的项目目录路径
 * @param create 是否为新建项目。为真时会初始化 `.nide` 目录结构
 * @param initiator 发起这次打开的渲染进程。确认框问到它那个窗口上
 * @param options 调用方传上来的确认选项。`{ confirm: false }` 时跳过换项目的二次确认
 */
async function activate(
  dirPath: string,
  create: boolean,
  initiator: WebContents,
  options: unknown
): Promise<ProjectOpenResult> {
  const current = getCurrentProject()?.path ?? null
  if (isProjectSwitch(current, dirPath, caseInsensitivePaths())) {
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

  const result = openProject(dirPath)

  if (!result.ok) {
    logger.warn('Failed to open a project', { reason: result.reason })
    return result
  }

  /**
   * 初始化在**开窗之前**完成：主窗口一打开，文件树与项目配置的第一次读取就可能
   * 落在一个还没有 `.nide` 的项目上。它自己不抛（失败在服务里降级成告警），
   * 所以这里的 await 只是等两次磁盘操作，不会把这次打开项目变成一次失败。
   */
  if (create) await initializeProjectDirectory(result.project.path)

  activateMainWindow()
  return result
}

export function registerProjectIPC(): void {
  ipcMain.handle(PROJECT_CHANNELS.list, () => getProjectList())

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
   * 会丢掉当前窗口的一切，所以先过行为级二次确认；确认之后这个窗口马上就会被拆掉，
   * 所以回执没有接收方，用单向 on 而不是 handle。
   */
  ipcMain.on(PROJECT_CHANNELS.close, (event, options: unknown): void => {
    void (async () => {
      if (!(await isActionConfirmed(event.sender, options, CONFIRM_SPECS.closeProject))) return

      closeProject()
      returnToWelcomeWindow()
    })()
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
   * 读一个内容目录里的章节列表。
   *
   * 与 readDir 同一套边界（根由主进程取当前项目、只认绝对路径、逐段比对），只是
   * 这一步还会**只读每个文件的头部**去取章节号。放到主进程做是因为渲染进程没有
   * 「读前 8 KiB」这个能力：它只有整文件读，而为一章的编号去读整篇正文不合适。
   */
  ipcMain.handle(
    PROJECT_FILE_CHANNELS.readChapters,
    async (_event, dirPath): Promise<ChapterListResult> => {
      const roots = allowedRoots()
      if (roots.length === 0) {
        logger.warn('Rejected a chapter read without an open project')
        return { ok: false, reason: 'outside-project' }
      }
      return readProjectChapters(String(dirPath ?? ''), {
        roots,
        caseInsensitive: caseInsensitivePaths()
      })
    }
  )

  /**
   * 项目配置（`.nide/config.yml`）。
   *
   * 和文件树一样，项目根由**主进程**取当前项目，渲染进程只声明「我要配置」——
   * 它指定不了读谁、更指定不了写到哪儿。没有项目时直接拒绝。
   *
   * 读通道会在 `.nide` 缺失或坏掉时静默重建默认配置（见 project-config.service），
   * 所以渲染进程永远拿得到一份可用的配置，不需要为「没有配置文件」写分支。
   */
  ipcMain.handle(PROJECT_CONFIG_CHANNELS.read, async (): Promise<ProjectConfig | null> => {
    const root = getCurrentProject()?.path
    if (!root) {
      logger.warn('Rejected a configuration read without an open project')
      return null
    }
    return loadProjectConfig(root)
  })

  /**
   * 更新配置。补丁在这里**不做形状信任**：服务端的 sanitizeProjectConfigPatch
   * 只认已知的四个键与非空字符串，校验不过时一项都不写。
   */
  ipcMain.handle(
    PROJECT_CONFIG_CHANNELS.update,
    async (_event, patch: unknown): Promise<ProjectConfigUpdateResult | null> => {
      const root = getCurrentProject()?.path
      if (!root) {
        logger.warn('Rejected a configuration update without an open project')
        return null
      }
      return updateProjectConfig(root, patch)
    }
  )

  /**
   * 新建文件 / 文件夹 —— 用户内容**唯一**的写入入口（宿主自己的 `.nide` 不算，
   * 那个由 project-config.service 管）。
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

  /**
   * 把编辑器里的正文写回一个文件（保存）。
   *
   * 与读取共用同一条范围校验，另外**只写宿主编解码得出来的格式**：这条通道是覆盖式
   * 的（不像新建那样只增不改），所以它至少要和「打开」一样窄。
   *
   * 没有二次确认：保存是用户的显式动作，问「确定要保存吗」等于把「我按下的就是保存」
   * 再问一遍。该拒的那些（目标没了、跑出项目、是个链接）由服务拒绝并回报原因。
   */
  ipcMain.handle(
    PROJECT_FILE_CHANNELS.writeFile,
    async (_event, request: unknown): Promise<FileWriteResult> => {
      const parsed = parseWriteRequest(request)
      if (!parsed) {
        logger.warn('Rejected a malformed write request')
        return { ok: false, reason: 'invalid-path' }
      }

      const roots = allowedRoots()
      if (roots.length === 0) {
        logger.warn('Rejected a write request without an open project')
        return { ok: false, reason: 'unreadable' }
      }

      return writeProjectFile(parsed, { roots, caseInsensitive: caseInsensitivePaths() })
    }
  )

  /**
   * 给一个条目改名。
   *
   * 和新建共用一条边界：目标目录不从渲染进程收，只收「被右键了谁」+「新名字」，
   * 目录由主进程从那个条目自己推出来（见 renameProjectEntry）。名字同样在这里
   * 校验 —— 界面是过滤器，主进程才是边界。
   */
  ipcMain.handle(
    PROJECT_FILE_CHANNELS.renameEntry,
    async (_event, request: unknown): Promise<RenameEntryResult> => {
      const parsed = parseRenameRequest(request)
      if (!parsed) {
        logger.warn('Rejected a malformed rename request')
        return { ok: false, reason: 'invalid-name' }
      }

      const roots = allowedRoots()
      if (roots.length === 0) {
        logger.warn('Rejected a rename request without an open project')
        return { ok: false, reason: 'unreadable' }
      }

      return renameProjectEntry(parsed, { roots, caseInsensitive: caseInsensitivePaths() })
    }
  )

  /**
   * 删除一个条目。目录连同里面的东西一起删。
   *
   * 只收一个路径：删多深没有参数可调，**根自己不能删**这条也在服务里兜着 ——
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

      const roots = allowedRoots()
      if (roots.length === 0) {
        logger.warn('Rejected a delete request without an open project')
        return { ok: false, reason: 'unreadable' }
      }

      /**
       * 目录与文件问的话不一样（目录会连同里面的东西一起删，文案要说得更重），
       * 所以先问一次磁盘上这个路径是什么。读到的结论**只影响文案**：删除自己
       * 在执行前会再判一次类型与边界，中间变了也不会因此少一道校验。
       */
      const kind = await entryKindAt(parsed.targetPath)
      const spec = kind === 'directory' ? CONFIRM_SPECS.deleteFolder : CONFIRM_SPECS.deleteFile

      if (
        !(await isActionConfirmed(event.sender, options, {
          ...spec,
          params: { name: path.basename(parsed.targetPath) }
        }))
      ) {
        return { ok: false, reason: 'cancelled' }
      }

      return deleteProjectEntry(parsed, { roots, caseInsensitive: caseInsensitivePaths() })
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

  const { kind, targetPath, name, content } = request as Partial<CreateEntryRequest>
  if (kind !== 'file' && kind !== 'directory') return null
  if (typeof targetPath !== 'string' || targetPath.length === 0) return null
  if (typeof name !== 'string') return null

  /**
   * 初始内容是可选的，但**给了就必须是字符串**：一个 `null` 或数字在这里被当成
   * 空内容，会让「文件为什么是空的」变成一个查不出来的问题。
   */
  if (content !== undefined && typeof content !== 'string') return null

  return { kind, targetPath, name, ...(content === undefined ? {} : { content }) }
}

/**
 * 校验一个保存请求的形状。
 *
 * 正文**必须**是字符串：IPC 载荷完全不可信，而把一个 null 或数字当空内容写进
 * 用户的稿子，是那种事后完全查不出来的损坏。路径同样只认非空字符串，范围校验
 * 留给服务（它才拿得到「当前项目」）。
 */
function parseWriteRequest(request: unknown): WriteFileRequest | null {
  if (!request || typeof request !== 'object') return null

  const { filePath, content } = request as Partial<WriteFileRequest>
  if (typeof filePath !== 'string' || filePath.length === 0) return null
  if (typeof content !== 'string') return null

  return { filePath, content }
}

/**
 * 校验一个改名请求的形状。
 *
 * 少一个 `kind` 字段（改名的类型由主进程从磁盘上问，不由渲染进程声明），其余
 * 与 parseCreateRequest 同理：IPC 载荷完全不可信，逐字段确认类型。
 */
function parseRenameRequest(request: unknown): RenameEntryRequest | null {
  if (!request || typeof request !== 'object') return null

  const { targetPath, name } = request as Partial<RenameEntryRequest>
  if (typeof targetPath !== 'string' || targetPath.length === 0) return null
  if (typeof name !== 'string') return null

  return { targetPath, name }
}

/** 校验一个删除请求的形状。只该有一个非空字符串路径 */
function parseDeleteRequest(request: unknown): DeleteEntryRequest | null {
  if (!request || typeof request !== 'object') return null

  const { targetPath } = request as Partial<DeleteEntryRequest>
  if (typeof targetPath !== 'string' || targetPath.length === 0) return null

  return { targetPath }
}
