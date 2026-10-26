import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
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
  createProjectEntry,
  deleteProjectEntry,
  readProjectDir,
  readProjectFile,
  renameProjectEntry,
  writeProjectFile
} from './services/project-files.ts'
import type {
  CreateEntryRequest,
  DeleteEntryRequest,
  RenameEntryRequest
} from '../../../src/shared/project/files.ts'

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
    'nide-host [--profile <name>] [--home <dir>] [--dump-config] [--once] [--reset]',
    '',
    '  --profile       profile 名称，默认 desktop',
    '  --home          NIDE_HOME 目录，默认 ~/.nide（开发用 .nide-dev）',
    '  --user-data     Electron userData 目录（projects.json 等）',
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
ensureProfile(paths, options.reset)

if (options.dumpConfig) {
  console.log(dumpRows(loadRows(paths)))
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
    projects: projects.list().length
  })
})

/**
 * 第一个业务 namespace：只读的项目列表。
 *
 * 先只读，等和旧 IPC（`hostAPI.projects.list`）的返回逐条对齐后，
 * 再加 open / forget / close。
 */
rpc.register('project', {
  list: () => projects.list(),
  current: () => projects.getCurrent(),
  startup: () => projects.resolveStartup(),
  setCurrent: (dirPath) => projects.setCurrent(String(dirPath ?? ''))
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

/**
 * 项目文件读写。
 *
 * `readDir` / `readFile` / `writeFile` 是第一批；`createEntry` / `renameEntry` /
 * `deleteEntry` 在同一份 service 上补齐，写路径的范围 / 链接 / 覆盖语义与主进程
 * 那份一致。删除的二次确认**不在这里**：host 没有窗口，preload 先问 shell 再调
 * 本方法（见 src/preload/index.ts 的 deleteEntry）。
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
  renameEntry: (request) => {
    const parsed = parseRenameEntryRequest(request)
    if (!parsed) return { ok: false, reason: 'invalid-name' }

    return renameProjectEntry(parsed, {
      roots: allowedRoots(),
      caseInsensitive: caseInsensitivePaths()
    })
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
 * 如果挂在 Electron shell 下，先挂 IPC 再宣告 ready。
 * 独立运行时 attached=false，行为和之前完全一致。
 */
const ipc = attachHostIpc({
  ready: {
    profile: paths.profileName,
    entries: host.entryIds.length,
    home: paths.home,
    userData: userDataDir
  },
  onShutdown: () => {
    logger.info('shutdown requested by shell')
    void shutdown(host).finally(() => process.exit(0))
  },
  onRpc: (request) => rpc.invoke(request)
})

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
