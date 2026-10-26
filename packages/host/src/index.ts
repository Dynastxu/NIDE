import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  REPO_ROOT,
  boot,
  dumpRows,
  ensureProfile,
  loadRows,
  resolveProfile,
  shutdown
} from '../../boot/src/index.ts'
import { attachHostIpc } from './ipc.ts'
import { RpcRegistry } from './rpc.ts'
import { HostProjectStore } from './services/project-store.ts'
import {
  checkProjectOverviewDocument,
  createProjectEntry,
  createProjectGallery,
  deleteProjectEntry,
  readProjectChapters,
  readProjectDir,
  readProjectForeshadowing,
  readProjectFile,
  readProjectGalleries,
  readProjectOverview,
  renameProjectEntry,
  writeProjectFile
} from './services/project-files.ts'
import {
  initializeProjectDirectory,
  loadGalleryRegistry,
  loadProjectConfig,
  remapOverviewRole,
  resolveConfigDirectory,
  updateGalleryRegistry,
  updateProjectConfig
} from './services/project-config.ts'
import { PluginManager, pluginPreferencePath } from './services/plugins.ts'
import { HostI18n } from './services/i18n.ts'
import { HostAppearance } from './services/appearance.ts'
import { AiProviderService, AiProviderServiceError } from './services/ai-provider.ts'
import { ProviderConfigStore } from './services/ai-provider-config.ts'
import { SecretVault } from './services/secrets.ts'
import { shell } from './shell.ts'
import type { TitleResolver } from './services/plugins.ts'
import {
  AI_PROVIDER_ERROR_CODES,
  type ChatOpenRequest,
  type ChatStreamEvent,
  type ProviderError,
  type SaveProviderRequest,
  type TestProviderRequest
} from '../../../src/shared/ai-provider/index.ts'

/** 把服务抛出的错误收敛成给渲染进程看的领域错误 */
function toProviderError(error: unknown): ProviderError {
  if (error instanceof AiProviderServiceError) return error.providerError
  return {
    code: AI_PROVIDER_ERROR_CODES.internal,
    message: error instanceof Error ? error.message : 'AI 供应商操作失败'
  }
}
import { filePathKey } from '../../../src/shared/project/files.ts'
import type {
  CreateEntryRequest,
  DeleteEntryRequest,
  RenameEntryRequest
} from '../../../src/shared/project/files.ts'
import type {
  GalleryCreateRequest,
  OverviewRoleUpdateRequest,
  ProjectConfig,
  ProjectConfigUpdateResult
} from '../../../src/shared/project/index.ts'

/**
 * 独立 host 进程入口（MVP）。
 *
 * 现在只做三件事：初始化 profile、按 loader 启动插件、优雅退出。
 * Electron shell 还没接进来（阶段 1 的下一步），所以这里可以先独立跑：
 *
 *   node packages/host/src/index.ts --profile desktop --dump-config
 *   node packages/host/src/index.ts --profile desktop --once
 *   node packages/host/src/index.ts --profile desktop
 *
 * TODO:
 * - 从 shell 的 MessagePort 接收 RPC / 事件
 * - `--inspect`、日志落盘、父进程退出联动
 * - 真正的 required 启动审计与失败报告
 */

interface Options {
  profile: string
  dumpConfig: boolean
  once: boolean
  reset: boolean
  help: boolean
  home?: string
  /** Electron 的 userData 目录；独立运行时默认落到 <home>/user-data。 */
  userData?: string
  /** 应用根目录（Electron 的 app.getAppPath()）；用来找 <root>/plugins/builtin。 */
  appRoot?: string
  /**
   * 编译产物根（`out/host`）。给了就不再从模块位置猜 profile 模板与
   * `{{NIDE_ROOT}}` —— 编译后模块位置已经不是源码树了。
   */
  distRoot?: string
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    profile: 'desktop',
    dumpConfig: false,
    once: false,
    reset: false,
    help: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--profile':
        options.profile = argv[++index] ?? options.profile
        break
      case '--home':
        options.home = argv[++index]
        break
      case '--user-data':
        options.userData = argv[++index]
        break
      case '--app-root':
        options.appRoot = argv[++index]
        break
      case '--dist-root':
        options.distRoot = argv[++index]
        break
      case '--dump-config':
        options.dumpConfig = true
        break
      case '--once':
        options.once = true
        break
      case '--reset':
        options.reset = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }

  return options
}

function usage(): string {
  return [
    'nide-host [--profile <name>] [--home <dir>] [--app-root <dir>] [--dump-config] [--once] [--reset]',
    '',
    '  --profile       profile 名称，默认 desktop',
    '  --home          NIDE_HOME 目录，默认 ~/.nide（开发用 .nide-dev）',
    '  --user-data     Electron userData 目录（projects.json 等）',
    '  --app-root      应用根目录（默认仓库根；打包时由 shell 传 resources/app）',
    '  --dist-root     编译产物根（out/host）；给了就用它的 profiles 模板与 {{NIDE_ROOT}}',
    '  --dump-config   只打印组合后的行，不启动插件',
    '  --once          启动后立即关闭（冒烟测试用）',
    '  --reset         先删掉 profile 目录再从模板重建（仅开发用）'
  ].join('\n')
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(usage())
  process.exit(0)
}

// 显式指定的 home 优先于环境变量；必须在 resolveProfile 之前写入。
if (options.home) process.env.NIDE_HOME = options.home

const paths = resolveProfile(options.profile)

/**
 * 编译产物根。
 *
 * 打包版由 shell 传 `--dist-root <appRoot>/out/host`：profile 模板、`{{NIDE_ROOT}}`
 * 都从那里解析（模板里的插件路径已改写成编译后的 `.js`）。独立运行 / 开发时
 * 没有这个参数，行为与之前完全一致（源码树里的 profiles）。
 */
const distRoot = options.distRoot ? path.resolve(options.distRoot) : null
ensureProfile(paths, options.reset, distRoot ? path.join(distRoot, 'profiles') : undefined)

if (options.dumpConfig) {
  console.log(dumpRows(loadRows(paths, distRoot ?? REPO_ROOT)))
  process.exit(0)
}

const host = await boot(paths)
const logger = host.ctx.logger('nide-host')

/**
 * userData 目录由 shell 传入（Electron 的 `app.getPath('userData')`）。
 * 独立运行时退回到 `<home>/user-data`，避免写到 NIDE_HOME 之外。
 */
const userDataDir = options.userData
  ? path.resolve(options.userData)
  : path.join(paths.home, 'user-data')
fs.mkdirSync(userDataDir, { recursive: true })

const projects = new HostProjectStore(userDataDir)
projects.resolveStartup()

/**
 * 插件目录。
 *
 * 内置插件在**应用根**下（dev = 仓库根，打包 = `resources/app`），由 shell 通过
 * `--app-root` 传进来；第三方插件在 userData 下，用户可写。独立运行 host 时没有
 * `--app-root`，回落到仓库根。
 */
const appRoot = options.appRoot ? path.resolve(options.appRoot) : REPO_ROOT
const plugins = new PluginManager({
  builtinDir: path.join(appRoot, 'plugins', 'builtin'),
  thirdPartyDir: path.join(userDataDir, 'plugins'),
  preferencePath: pluginPreferencePath(userDataDir)
})

/**
 * 本地化。
 *
 * 语言包来自插件目录（`plugins.contributions().locales`），偏好文件也在 userData —
 * 所以「用哪个语言」这件事完全在 host 里决定，shell 只传系统语言候选（那只有
 * Electron 知道）。每次 i18n 调用前重灌一遍语言包：安装 / 卸载插件之后集合会变。
 */
const i18n = new HostI18n({ userDataDir })

/**
 * 主题 / 外观。
 *
 * 偏好文件（`appearance.json`）与「哪套主题生效」的解析都在这里；`nativeTheme`
 * 那一下通过反向桥请 shell 做。shell 缓存一份状态，因为开窗要同步拿窗口底色。
 */
const appearance = new HostAppearance({ userDataDir })

/**
 * AI 供应商。
 *
 * 服务本身是**插件后端的替身**（`builtin.ai-provider` 的 `main` 侧还没做），
 * 但它依赖的数据都在 host 的 userData 下：`ai-provider/providers.json` 与
 * `secrets/<owner>/<id>.bin`（密文）。密钥的加解密走反向桥（`safeStorage`）。
 */
const secrets = new SecretVault(path.join(userDataDir, 'secrets'))
const ai = new AiProviderService(
  new ProviderConfigStore(path.join(userDataDir, 'ai-provider', 'providers.json')),
  secrets
)

/**
 * 流式事件出口。
 *
 * 由 host 入口在 IPC 就绪后注入（`ipc.send`）—— RPC 注册先于 attach，所以这里
 * 先放一个空实现，等接上再换。AI 对话的 SSE 分片走这条通道，和请求-响应分开。
 */
let emitStreamEvent: (event: ChatStreamEvent) => void = () => {}

function syncLanguagePacks(): void {
  i18n.setPacks(plugins.contributions().locales)
}

/** 贡献点的标题解析器：交给 `HostI18n`，它知道当前语言与 manifest 词条 */
const resolveTitle: TitleResolver = (pluginId, titleSpec, fallback) =>
  i18n.resolveTitle(plugins.manifestNls(pluginId), titleSpec) || fallback

/** 文件读取的允许根：MVP 只有当前项目一个。 */
function allowedRoots(): string[] {
  const root = projects.getCurrent()?.path
  return root ? [root] : []
}

function caseInsensitivePaths(): boolean {
  return process.platform === 'win32'
}

/**
 * 第一批 namespace。
 *
 * `host` 只提供诊断信息；真正的业务 namespace（project / files / editor）
 * 在阶段 2 逐个搬进来。注册点刻意留在这里，方便看出「哪些能力已经搬完」。
 *
 * TODO: 从 ctx 服务自动注册；参数 schema 校验。
 */
const rpc = new RpcRegistry()
rpc.register('host', {
  ping: () => ({ pong: Date.now() }),
  info: () => ({
    profile: paths.profileName,
    entries: host.entryIds.length,
    home: paths.home,
    userData: userDataDir,
    appRoot,
    projects: projects.list().length,
    plugins: plugins.list().length
  })
})

/**
 * 「打开过的项目」。
 *
 * 这份 `projects.json` 的**唯一**实现：读、写、当前项目都在这里。shell 不再碰这个
 * 文件，它只负责目录对话框、二次确认与窗口；窗口要的「当前项目」由本 namespace 给。
 *
 * - `startup`：启动时该默认打开哪个（它同时把「当前项目」定下来）
 * - `open` / `forget` / `close`：打开 / 从列表移除 / 结束这次会话
 * - `setCurrent`：窗口绑定同步（端口建立后 preload 把建窗时的 `--nide-project=` 送上来）
 *
 * 只认**列表里已有**的记录这一点只在 `setCurrent` 里：`open` 是唯一会新增记录的方法，
 * 其余入口都不该凭空造出一个项目。
 */
rpc.register('project', {
  list: () => projects.list(),
  current: () => projects.getCurrent(),
  startup: () => projects.resolveStartup(),
  setCurrent: (dirPath) => projects.setCurrent(String(dirPath ?? '')),

  open: (dirPath) => projects.open(String(dirPath ?? '')),
  forget: (dirPath) => {
    projects.forget(String(dirPath ?? ''))
    return projects.list()
  },
  close: () => {
    projects.close()
    return null
  }
})

/**
 * 请求形状校验：host 收到的是渲染进程经 MessagePort 发来的 JSON，形状完全不可信。
 * 名字的合法性仍由 service 用 `validateEntryName` 判，这一层只确认类型。
 */
function parseCreateEntryRequest(value: unknown): CreateEntryRequest | null {
  if (!value || typeof value !== 'object') return null

  const { kind, targetPath, name, content } = value as Partial<CreateEntryRequest>
  if (kind !== 'file' && kind !== 'directory') return null
  if (typeof targetPath !== 'string' || targetPath.length === 0) return null
  if (typeof name !== 'string') return null
  // 初始内容可以不给；给了就必须是字符串（null / 数字不能被悄悄写成 "null" / "42"）
  if (content !== undefined && typeof content !== 'string') return null

  return { kind, targetPath, name, ...(content === undefined ? {} : { content }) }
}

function parseRenameEntryRequest(value: unknown): RenameEntryRequest | null {
  if (!value || typeof value !== 'object') return null

  const { targetPath, name } = value as Partial<RenameEntryRequest>
  if (typeof targetPath !== 'string' || targetPath.length === 0) return null
  if (typeof name !== 'string') return null

  return { targetPath, name }
}

function parseDeleteEntryRequest(value: unknown): DeleteEntryRequest | null {
  if (!value || typeof value !== 'object') return null

  const { targetPath } = value as Partial<DeleteEntryRequest>
  if (typeof targetPath !== 'string' || targetPath.length === 0) return null

  return { targetPath }
}

/** 图鉴 / 概述通道的请求形状校验（与主进程的 parse* 一一对应） */
function parseGalleryCreateRequest(value: unknown): GalleryCreateRequest | null {
  if (!value || typeof value !== 'object') return null

  const { targetPath, name } = value as Partial<GalleryCreateRequest>
  if (typeof targetPath !== 'string' || targetPath.length === 0) return null
  if (typeof name !== 'string') return null

  return { targetPath, name }
}

function parseGalleryRegistryRequest(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null

  const { characters } = value as { characters?: unknown }
  if (typeof characters !== 'string' || characters.length === 0) return null

  return characters
}

function parseOverviewRoleRequest(value: unknown): OverviewRoleUpdateRequest | null {
  if (!value || typeof value !== 'object') return null

  const { role, fileName } = value as Partial<OverviewRoleUpdateRequest>
  if (role !== 'outline' && role !== 'style') return null
  if (typeof fileName !== 'string' || fileName.length === 0) return null

  return { role, fileName }
}

/**
 * 配置里那个图鉴内容目录的绝对路径；读不到配置时给 null。
 *
 * 图鉴的三个通道都要它：渲染进程报上来的路径必须**正是**这一个，否则拒绝 —— 不判的
 * 话，「读图鉴」就成了一条枚举项目里任意一层子目录的通道。
 */
async function resolveGalleryRoot(root: string): Promise<string | null> {
  try {
    const config = await loadProjectConfig(root)
    return resolveConfigDirectory(root, config.gallery.path)
  } catch (error) {
    console.warn('[nide-host] failed to resolve the gallery directory', { error })
    return null
  }
}

/** 当前项目的概述配置与内容目录绝对路径；读不到配置时给 null */
async function resolveOverviewContext(
  root: string
): Promise<{ config: ProjectConfig; path: string } | null> {
  try {
    const config = await loadProjectConfig(root)
    return { config, path: resolveConfigDirectory(root, config.overview.path) }
  } catch (error) {
    console.warn('[nide-host] failed to resolve the overview directory', { error })
    return null
  }
}

/** 两个路径是不是同一个位置。大小写按平台语义折叠（与范围校验同一条约定） */
function samePath(left: string, right: string): boolean {
  if (right.length === 0) return false

  const caseInsensitive = caseInsensitivePaths()
  return filePathKey(left, caseInsensitive) === filePathKey(right, caseInsensitive)
}

/**
 * 项目文件读写。
 *
 * 读路径：`readDir` / `readFile` / `readChapters` / `readForeshadowing`；写路径：
 * `writeFile` / `createEntry` / `renameEntry` / `deleteEntry`。范围 / 链接 / 覆盖
 * 语义与主进程那份一致。删除的二次确认**不在这里**：host 没有窗口，preload 先问
 * shell 再调本方法；改名之后的概述映射在 host 内部补（配置服务已经在这里）。
 */
rpc.register('files', {
  readDir: (dirPath) =>
    readProjectDir(String(dirPath ?? ''), {
      roots: allowedRoots(),
      caseInsensitive: caseInsensitivePaths()
    }),
  readFile: (filePath) =>
    readProjectFile(String(filePath ?? ''), {
      roots: allowedRoots(),
      caseInsensitive: caseInsensitivePaths()
    }),
  readChapters: (dirPath) =>
    readProjectChapters(String(dirPath ?? ''), {
      roots: allowedRoots(),
      caseInsensitive: caseInsensitivePaths()
    }),
  readForeshadowing: (dirPath) =>
    readProjectForeshadowing(String(dirPath ?? ''), {
      roots: allowedRoots(),
      caseInsensitive: caseInsensitivePaths()
    }),
  writeFile: (request) => {
    const payload = (request ?? {}) as { filePath?: unknown; content?: unknown }
    return writeProjectFile(
      {
        filePath: String(payload.filePath ?? ''),
        content: payload.content as string
      },
      {
        roots: allowedRoots(),
        caseInsensitive: caseInsensitivePaths()
      }
    )
  },
  createEntry: (request) => {
    const parsed = parseCreateEntryRequest(request)
    if (!parsed) return { ok: false, reason: 'invalid-name' }

    return createProjectEntry(parsed, {
      roots: allowedRoots(),
      caseInsensitive: caseInsensitivePaths()
    })
  },
  renameEntry: async (request) => {
    const parsed = parseRenameEntryRequest(request)
    if (!parsed) return { ok: false, reason: 'invalid-name' }

    const result = await renameProjectEntry(parsed, {
      roots: allowedRoots(),
      caseInsensitive: caseInsensitivePaths()
    })

    /**
     * 概述里的大纲 / 写作风格是按**文件名**记在 `.nide/config.yml` 里的：改名之后
     * 不跟着改，那条映射就断了。配置服务已经在 host，这一步直接在这里做。
     * 失败只记日志：改名本身已经落盘，不能把它报成失败。
     */
    if (result.ok) {
      const root = projects.getCurrent()?.path
      if (root) {
        try {
          await remapOverviewRole(root, result.previousPath, result.path)
        } catch (error) {
          console.warn('[nide-host] failed to remap the overview role after a rename', { error })
        }
      }
    }

    return result
  },
  deleteEntry: (request) => {
    const parsed = parseDeleteEntryRequest(request)
    if (!parsed) return { ok: false, reason: 'unreadable' }

    return deleteProjectEntry(parsed, {
      roots: allowedRoots(),
      caseInsensitive: caseInsensitivePaths()
    })
  }
})

/**
 * 图鉴：内容目录下每个子目录一个图鉴。
 *
 * 与文件树同一套边界（根由 host 取当前项目，渲染进程只声明路径），另外多一条：
 * 报上来的路径必须**正是配置里那个图鉴内容目录**。注册表与列表在同一个结果里，
 * 因为界面上总是一起用。
 */
rpc.register('gallery', {
  read: async (targetPath) => {
    const roots = allowedRoots()
    const root = roots[0]
    if (!root) return { ok: false, reason: 'outside-project' }

    const galleryRoot = await resolveGalleryRoot(root)
    if (galleryRoot === null || !samePath(galleryRoot, String(targetPath ?? ''))) {
      return { ok: false, reason: 'outside-project' }
    }

    const listing = await readProjectGalleries(galleryRoot, {
      roots,
      caseInsensitive: caseInsensitivePaths()
    })
    if (!listing.ok) return listing

    return {
      ok: true,
      path: listing.path,
      registry: await loadGalleryRegistry(root),
      galleries: listing.galleries
    }
  },

  create: async (request) => {
    const parsed = parseGalleryCreateRequest(request)
    if (!parsed) return { ok: false, reason: 'invalid-name' }

    const roots = allowedRoots()
    const root = roots[0]
    if (!root) return { ok: false, reason: 'unreadable' }

    const galleryRoot = await resolveGalleryRoot(root)
    if (galleryRoot === null || !samePath(galleryRoot, parsed.targetPath)) {
      return { ok: false, reason: 'not-a-directory' }
    }

    return createProjectGallery(parsed, {
      roots,
      caseInsensitive: caseInsensitivePaths()
    })
  },

  updateRegistry: async (request) => {
    const root = projects.getCurrent()?.path
    if (!root) return null

    const characters = parseGalleryRegistryRequest(request)
    if (characters === null) return { ok: false, reason: 'invalid-name' }

    return updateGalleryRegistry(root, characters)
  }
})

/**
 * 概述：内容目录里平铺的 Markdown，其中两份被项目配置登记成大纲 / 写作风格。
 *
 * 与图鉴同一套边界，另外多一条：报上来的路径必须正是配置里那个概述内容目录。
 */
rpc.register('overview', {
  read: async (targetPath) => {
    const roots = allowedRoots()
    const root = roots[0]
    if (!root) return { ok: false, reason: 'outside-project' }

    const overview = await resolveOverviewContext(root)
    if (overview === null || !samePath(overview.path, String(targetPath ?? ''))) {
      return { ok: false, reason: 'outside-project' }
    }

    return readProjectOverview(overview.path, {
      roots,
      caseInsensitive: caseInsensitivePaths()
    })
  },

  setRole: async (request) => {
    const parsed = parseOverviewRoleRequest(request)
    if (!parsed) return { ok: false, reason: 'invalid-name' }

    const roots = allowedRoots()
    const root = roots[0]
    if (!root) return { ok: false, reason: 'unreadable' }

    const overview = await resolveOverviewContext(root)
    if (overview === null) return { ok: false, reason: 'unreadable' }

    const options = { roots, caseInsensitive: caseInsensitivePaths() }
    const check = await checkProjectOverviewDocument(overview.path, parsed.fileName, options)
    if (check !== 'ok') return { ok: false, reason: check }

    const updated = await updateProjectConfig(root, {
      overview: { [parsed.role]: parsed.fileName }
    })

    if (!updated.ok) return { ok: false, reason: 'invalid-name' }
    return { ok: true, config: updated.config }
  }
})

/**
 * 项目配置（`.nide/config.yml`）。
 *
 * 项目根由 host 取当前项目，渲染进程只声明「我要配置」—— 它指定不了读谁、更指定
 * 不了写到哪儿。服务会在 `.nide` 缺失或坏掉时静默重建默认配置，所以调用方永远拿得到
 * 一份可用的配置。
 */
rpc.register('config', {
  read: async (): Promise<ProjectConfig | null> => {
    const root = projects.getCurrent()?.path
    if (!root) return null

    return loadProjectConfig(root)
  },

  update: async (patch): Promise<ProjectConfigUpdateResult | null> => {
    const root = projects.getCurrent()?.path
    if (!root) return null

    return updateProjectConfig(root, patch)
  },

  /**
   * 初始化一个**刚新建**的项目：默认配置、内容目录、默认角色图鉴与概述预设。
   *
   * 由 shell 在「新建项目」时经父端口调用（`invokeHost('config','initialize')`）：
   * 打开已有项目**不**走这里 —— 那会替用户建出他删过的东西。
   */
  initialize: async (root): Promise<ProjectConfig | null> => {
    const target = String(root ?? '')
    if (target.length === 0) return null

    return initializeProjectDirectory(target)
  }
})

/**
 * 插件：装了哪些、哪些被禁用、浏览器半在哪、界面里有哪些视图与设置页。
 *
 * 读盘、收敛、**标题解析**都在 host：视图 / 设置页描述符直接给已解析的 `title`，
 * 语言来自上面的 `i18n`。shell 只做两件事：把内建视图拼在视图表前面（那几条标题是
 * 宿主的词条，用 shell 缓存的载荷翻），以及按需转发。
 */
rpc.register('plugins', {
  list: () => plugins.list(),
  disabled: () => plugins.disabled(),
  setEnabled: (pluginId, enabled) => {
    plugins.setEnabled(String(pluginId ?? ''), enabled === true)
    return plugins.disabled()
  },
  clientBundles: () => plugins.clientBundles(),

  /** 视图表（协议视图之外的插件视图），标题已按当前语言解析 */
  views: () => plugins.views(resolveTitle),

  /** 设置页，已滤掉被禁用插件的页，标题已解析 */
  settings: () => plugins.settings(resolveTitle),

  install: (sourceDir) => {
    const result = plugins.install(String(sourceDir ?? ''))
    syncLanguagePacks()
    return result
  },
  remove: (pluginId) => {
    const result = plugins.remove(String(pluginId ?? ''))
    syncLanguagePacks()
    return result
  },

  /** 重新扫描目录（安装 / 卸载之后由 shell 调用） */
  rescan: () => {
    plugins.scan()
    syncLanguagePacks()
    return plugins.list()
  }
})

/**
 * 本地化。
 *
 * `init` 由 shell 在启动时调用一次（它把 Electron 才知道的系统语言候选传进来），
 * `setLocale` 是设置页切语言走的路 —— 落盘与重建载荷在 host，重建窗口在 shell。
 * `payload` 给渲染进程与 shell 的 `t()` 用（shell 缓存一份，见 `src/main/i18n`）。
 */
rpc.register('i18n', {
  init: (request) => {
    syncLanguagePacks()
    const system = (request as { system?: unknown } | undefined)?.system
    return i18n.init(Array.isArray(system) ? system.map((tag) => String(tag)) : [])
  },
  setLocale: (locale) => {
    syncLanguagePacks()
    return i18n.setLocale(String(locale ?? ''))
  },
  payload: () => i18n.payload()
})

/**
 * 主题 / 外观。
 *
 * `setTheme` 落盘并更新原生明暗，返回新状态；主题不存在时回 null（shell 据此
 * 告诉设置页「没改成」）。`payload` 给 shell 缓存与渲染进程的查询用。
 */
rpc.register('appearance', {
  init: () => appearance.init(),
  payload: () => appearance.payload(),
  setTheme: (request) => {
    const payload = (request ?? {}) as { theme?: unknown; followSystem?: unknown }
    return appearance.setTheme(String(payload.theme ?? ''), payload.followSystem === true)
  }
})

/**
 * AI 供应商：设置页的读写 + Agent 的透明转发。
 *
 * `save` / `remove` 把**领域错误**当成返回值（`{ ok:false, error:{ code, message } }`），
 * 而不是抛出去：错误码是给渲染进程看的数据（`keyRequired` / `baseUrlConflict` …），
 * RPC 的错误包装只剩一个 message，跨进程后就分不清了。
 *
 * `open` 返回 `requestId`，之后的 SSE 分片走 `stream-event`（见 `emitStreamEvent`）。
 */
rpc.register('ai', {
  list: async () => {
    try {
      return await ai.list()
    } catch (error) {
      console.warn('[nide-host] failed to list AI providers', { error })
      return []
    }
  },

  save: async (request) => {
    try {
      return { ok: true, provider: await ai.save(request as SaveProviderRequest) }
    } catch (error) {
      return { ok: false, error: toProviderError(error) }
    }
  },

  remove: async (providerId) => {
    try {
      await ai.remove(String(providerId ?? ''))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: toProviderError(error) }
    }
  },

  test: (request) => ai.test(request as TestProviderRequest),

  open: (request) =>
    ai.open(request as ChatOpenRequest, (event) => {
      emitStreamEvent(event)
    }),

  abort: (requestId) => {
    ai.abort(String(requestId ?? ''))
  },

  abortAll: () => {
    ai.abortAll()
  }
})

/**
 * 如果挂在 Electron shell 下，先挂 IPC 再宣告 ready。
 * 独立运行时 attached=false，行为和之前完全一致。
 */
const ipc = attachHostIpc({
  ready: {
    profile: paths.profileName,
    entries: host.entryIds.length,
    home: paths.home,
    userData: userDataDir,
    appRoot
  },
  onShutdown: () => {
    logger.info('shutdown requested by shell')
    void shutdown(host).finally(() => process.exit(0))
  },
  onRpc: (request) => rpc.invoke(request),
  onShellResult: (message) => {
    if (!shell.settle(message)) logger.warn('shell result arrived after its call settled')
  }
})

/**
 * 反向能力桥（D7 的 `ctx.shell`）：主题 / `safeStorage` 这类只有 Electron 有的
 * 能力。独立运行时（`--once` / `pnpm host:dev`）不接，调用方会拿到明确的错误。
 */
if (ipc.attached) {
  shell.attach((message) => ipc.send(message))
  logger.info('shell capabilities attached')

  /**
   * 流式事件出口接上：`ipc.send` 走父端口，shell 按 requestId 找到发起那次请求的
   * 窗口再转给渲染进程（见 `src/main/host/process.ts` 的 stream-event 分发）。
   */
  emitStreamEvent = (event) => {
    ipc.send({ type: 'stream-event', requestId: event.requestId, event })
  }
}

logger.info(
  `host ready: profile=${paths.profileName} entries=${host.entryIds.length} home=${paths.home} ipc=${ipc.attached}`
)

if (options.once) {
  await shutdown(host)
  logger.info('host stopped (--once)')
  process.exit(0)
}

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    logger.info(`received ${signal}, shutting down`)
    void shutdown(host).finally(() => process.exit(0))
  })
}

// 没有这一步，事件循环只被插件的 effect 撑着；MVP 用一个永不 resolve 的 Promise
// 明确表达「host 是常驻进程」。
await new Promise<void>(() => {})
