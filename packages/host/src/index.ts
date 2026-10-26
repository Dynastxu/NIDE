import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  REPO_ROOT,
  boot,
  toImportSpecifier,
  dumpRows,
  ensureProfile,
  loadRows,
  resolveProfile,
  shutdown
} from '../../boot/src/index.ts'
import { attachHostIpc } from '../../kernel/src/ipc.ts'
import { RpcRegistry } from '../../kernel/src/rpc.ts'
import { installNideContext, type HostEnvironment } from '../../kernel/src/context.ts'
import type { HostProjectStore } from '../../services/project/src/host-project-store.ts'
import type { PluginManager } from '../../services/plugins/src/plugins.ts'
import {
  initializeProjectDirectory,
  loadProjectConfig,
  updateProjectConfig
} from '../../services/config/src/project-config.ts'
import { shell } from '../../kernel/src/shell.ts'
import type { AiService } from '../../services/ai/src/index.ts'
import type { ChatStreamEvent } from '../../../packages/contracts/src/ai-provider/index.ts'

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
 * 内置插件与应用根的关系由 plugins 服务自己从 `ctx.env.appRoot` 读；
 * 这里仍保留 appRoot 给 ready 报文用。
 */
const appRoot = options.appRoot ? path.resolve(options.appRoot) : REPO_ROOT

/**
 * 流式事件出口。
 *
 * 由 host 入口在 IPC 就绪后注入（`ipc.send`）—— RPC 注册先于 attach，所以这里
 * 先放一个空实现，等接上再换。AI 对话的 SSE 分片走这条通道，和请求-响应分开。
 */
let emitStreamEvent: (event: ChatStreamEvent) => void = () => {}

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
/**
 * `kind: service` 的行由 profile 决定（`cordis.yml`），顺序就是 apply 顺序。
 *
 * 服务模块很薄（一个 `{ name, apply }` 对象），动态 import 只是为了跟 loader 用
 * 同一种「由 profile 指向文件」的装配方式 —— 加一个服务 = 加一行，不改这里。
 */
interface HostService {
  name: string
  apply(ctx: typeof hostCtx): void
}

for (const row of host.services) {
  const module = (await import(toImportSpecifier(row.name))) as { default?: HostService }
  const service = module.default
  if (!service || typeof service.apply !== 'function') {
    throw new Error(`profile row "${row.id}" is marked as a service but does not export one`)
  }
  service.apply(hostCtx)
}

/** 项目生命周期服务（`provide('project', …)` 在它的 apply 里做过） */
const projects = hostCtx.services.require<HostProjectStore>('project')

/** AI 的分片出口：接到父端口的 `stream-event`（IPC attach 之后才真正可用） */
hostCtx.services.require<AiService>('ai').setStreamSink((event) => {
  emitStreamEvent(event)
})

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
    plugins: hostCtx.services.require<PluginManager>('plugins').list().length
  })
})

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
