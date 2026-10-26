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
import { attachHostIpc } from '../../kernel/src/ipc.ts'
import { RpcRegistry } from '../../kernel/src/rpc.ts'
import { installNideContext, type HostEnvironment } from '../../kernel/src/context.ts'
import { projectService } from '../../services/project/src/index.ts'
import type { HostProjectStore } from '../../services/project/src/host-project-store.ts'
import {
  initializeProjectDirectory,
  loadProjectConfig,
  updateProjectConfig
} from '../../services/config/src/project-config.ts'
import { contentService } from '../../services/content/src/index.ts'
import { PluginManager, pluginPreferencePath } from './services/plugins.ts'
import { builtinViews } from './services/builtin-views.ts'
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
} from '../../../packages/contracts/src/ai-provider/index.ts'

/** 把服务抛出的错误收敛成给渲染进程看的领域错误 */
function toProviderError(error: unknown): ProviderError {
  if (error instanceof AiProviderServiceError) return error.providerError
  return {
    code: AI_PROVIDER_ERROR_CODES.internal,
    message: error instanceof Error ? error.message : 'AI 供应商操作失败'
  }
}
import type {
  ProjectConfig,
  ProjectConfigUpdateResult
} from '../../../packages/contracts/src/project/index.ts'

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

/**
 * 第一批 namespace。
 *
 * `host` 只提供诊断信息；真正的业务 namespace（project / files / editor）
 * 在阶段 2 逐个搬进来。注册点刻意留在这里，方便看出「哪些能力已经搬完」。
 *
 * TODO: 从 ctx 服务自动注册；参数 schema 校验。
 */
const rpc = new RpcRegistry()

/**
 * 把 `ctx.rpc` / `ctx.services` / `ctx.env` 挂到 Cordis 上下文上。
 *
 * 这是「一切皆插件」的接入点：服务包只需要 `{ name, apply(ctx) }`，不 import 内核。
 * 现阶段装配仍在本文件，但它已经不需要知道服务怎么实现 —— 只负责把它们挂上 ctx。
 */
const env: HostEnvironment = {
  profileDir: paths.profileDir,
  profileName: paths.profileName,
  home: paths.home,
  userDataDir,
  appRoot
}
const hostCtx = installNideContext(host.ctx, {
  rpc: { register: (namespace, handlers) => rpc.register(namespace, handlers) },
  env
})

/**
 * 服务装配。
 *
 * 直接调 `apply` 而不是 `ctx.plugin(...)`：Cordis 的 plugin 是异步挂载的，
 * 而这里需要「装配完立刻能用」（下面的 `require` 就在同一个 tick）。服务对象本身
 * 仍是 `{ name, apply(ctx) }` 的形状 —— 以后 loader 支持包标识符时，同一个对象
 * 可以原样交给 `ctx.plugin`。
 *
 * 顺序只对「谁先 provide」有影响；服务之间一律在**调用时**用
 * `ctx.services.require(...)` 取，所以顺序不构成依赖。
 */
for (const service of [projectService, contentService]) {
  service.apply(hostCtx)
}

/** 项目生命周期服务（`provide('project', …)` 在它的 apply 里做过） */
const projects = hostCtx.services.require<HostProjectStore>('project')

// 第一个走 ctx.rpc 的命名空间：服务包照这个形状注册自己的 namespace
hostCtx.rpc.register('host', {
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
/**
/**
 * 项目文件读写。
 *
 * 读路径：`readDir` / `readFile` / `readChapters` / `readForeshadowing`；写路径：
 * `writeFile` / `createEntry` / `renameEntry` / `deleteEntry`。范围 / 链接 / 覆盖
 * 语义与主进程那份一致。删除的二次确认**不在这里**：host 没有窗口，preload 先问
 * shell 再调本方法；改名之后的概述映射在 host 内部补（配置服务已经在这里）。
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

  /** 视图表：内建视图（文件树 / 版本控制 / 提交）在前，插件视图在后，标题都已解析 */
  views: () => [...builtinViews((key) => i18n.message(key)), ...plugins.views(resolveTitle)],

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
