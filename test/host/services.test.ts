import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  hostServices,
  installNideContext,
  type NideContext
} from '../../packages/kernel/src/context.ts'
import { RpcRegistry } from '../../packages/kernel/src/rpc.ts'
import { projectService } from '../../packages/project/src/index.ts'
import { contentService } from '../../packages/content/src/index.ts'
import { configService } from '../../packages/config/src/index.ts'
import { pluginsService } from '../../packages/plugin-runtime/src/index.ts'
import { i18nService } from '../../packages/i18n/src/index.ts'
import { appearanceService } from '../../packages/appearance/src/index.ts'
import { secretsService } from '../../packages/secrets/src/index.ts'
import { aiService } from '../../packages/ai/src/index.ts'
import {
  CORE_PACKAGES,
  type CorePackage
} from '../../packages/contracts/src/plugin-api/core-packages.ts'

/**
 * 服务装配（阶段 A 的收口）。
 *
 * 服务现在就是普通 Cordis 插件：挂上去、按 `inject` 等依赖、各自注册 RPC 命名空间。
 * 「装配完到底有哪些命名空间」没有静态保证，所以这里把整条链跑一遍（真的构造实例、
 * 真的注册到 RpcRegistry），钉住命名空间集合。
 *
 * 用的是临时 userData 与 `appRoot`，不碰仓库里的 plugins/。
 */
const services = [
  projectService,
  contentService,
  configService,
  pluginsService,
  i18nService,
  appearanceService,
  secretsService,
  aiService
]

let base = ''

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'nide-services-'))
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

async function bootServices(
  profileRows: readonly {
    id: string
    name: string
    core?: boolean
    description?: string
  }[] = []
): Promise<{ ctx: NideContext; rpc: RpcRegistry; namespaces: string[] }> {
  const rpc = new RpcRegistry()
  const namespaces: string[] = []
  const ctx = installNideContext(new Context(), {
    rpc: {
      register: (namespace, handlers) => {
        namespaces.push(namespace)
        return rpc.register(namespace, handlers)
      }
    },
    env: {
      profileDir: path.join(base, 'profile'),
      profileName: 'desktop',
      home: base,
      userDataDir: path.join(base, 'user-data'),
      appRoot: path.join(base, 'app'),
      profileRows
    }
  })

  // 服务通过 inject 取 rpc / hostEnv：先在插件树里把它们 provide 出来
  await ctx.plugin(hostServices({ rpc: ctx.rpc, env: ctx.hostEnv }))

  // 先全部挂上，再等它们各自按 inject 就绪：顺序不再由数组顺序保证
  const fibers = services.map((service) => ctx.plugin(service))
  await Promise.all(fibers)

  return { ctx, rpc, namespaces }
}

describe('host 服务装配', () => {
  it('每个服务都注册了它负责的命名空间', async () => {
    const { namespaces } = await bootServices()

    expect(namespaces.sort()).toEqual(
      [
        'project',
        'files',
        'gallery',
        'overview',
        'config',
        'plugin',
        'plugins',
        'i18n',
        'appearance',
        'ai'
      ].sort()
    )
  })

  it('服务名唯一（复制粘贴改名漏改会在这里暴露）', () => {
    const names = services.map((service) => service.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('依赖就绪之后服务挂在上下文上（ctx.<service> 可用）', async () => {
    const { ctx } = await bootServices()

    expect(ctx.project.list()).toEqual([])
    expect(ctx.plugins.list()).toEqual([])
    expect(ctx.appearance.payload().theme).toBeTruthy()
    expect(ctx.get('i18n')).toBeTruthy()
    expect(ctx.get('ai')).toBeTruthy()
  })

  it('装配之后 RPC 是通的（未知 namespace 会回 unknown-namespace）', async () => {
    const { rpc } = await bootServices()

    await expect(
      rpc.invoke({ type: 'rpc', id: 'r1', namespace: 'project', method: 'list', args: [] })
    ).resolves.toMatchObject({ ok: true })
  })

  it('plugins.core：profile 里的 core 行 + 静态平台包，全部只读且有说明', async () => {
    const { rpc } = await bootServices([
      {
        id: 'project',
        name: '{{NIDE_ROOT}}/packages/project/src/index.ts',
        core: true,
        description: '项目生命周期'
      }
    ])

    const response = await rpc.invoke({
      type: 'rpc',
      id: 'core',
      namespace: 'plugins',
      method: 'core',
      args: []
    })

    expect(response).toMatchObject({ ok: true })
    const list = (response as { ok: true; result: CorePackage[] }).result

    // 宿主服务那部分来自 profile（这里只给了一条），客户端平台包来自静态表
    expect(list.filter((entry) => entry.kind === 'service')).toEqual([
      {
        id: 'project',
        name: 'project',
        kind: 'service',
        path: '{{NIDE_ROOT}}/packages/project/src/index.ts',
        description: '项目生命周期'
      }
    ])
    expect(list.filter((entry) => entry.kind === 'package')).toHaveLength(CORE_PACKAGES.length)
    expect(list.every((entry) => entry.id && entry.name && entry.path)).toBe(true)

    // 展示路径必须是相对的：绝对路径会把用户的安装位置暴露到界面上
    expect(list.every((entry) => !path.isAbsolute(entry.path))).toBe(true)
  })
})
