import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installNideContext } from '../../packages/kernel/src/context.ts'
import { RpcRegistry } from '../../packages/kernel/src/rpc.ts'
import { projectService } from '../../packages/services/project/src/index.ts'
import { contentService } from '../../packages/services/content/src/index.ts'
import { configService } from '../../packages/services/config/src/index.ts'
import { pluginsService } from '../../packages/services/plugins/src/index.ts'
import { i18nService } from '../../packages/services/i18n/src/index.ts'
import { appearanceService } from '../../packages/services/appearance/src/index.ts'
import { secretsService } from '../../packages/services/secrets/src/index.ts'
import { aiService } from '../../packages/services/ai/src/index.ts'
import {
  CORE_PACKAGES,
  type CorePackage
} from '../../packages/contracts/src/plugin-api/core-packages.ts'

/**
 * 服务装配（阶段 3 的收口）。
 *
 * 每个服务自己注册 RPC 命名空间，所以「装配完到底有哪些命名空间」没有任何静态
 * 保证 —— 少挂一个服务、或者某个 apply 抛错，typecheck 都看不出来。这里把整条
 * 装配链跑一遍（真的构造实例、真的注册到 RpcRegistry），钉住命名空间集合与
 * 服务名唯一性。
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

function bootServices(
  profileRows: readonly { id: string; name: string; kind?: string; description?: string }[] = []
): { rpc: RpcRegistry; namespaces: string[] } {
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

  for (const service of services) {
    service.apply(ctx)
  }

  return { rpc, namespaces }
}

describe('host 服务装配', () => {
  it('每个服务都注册了它负责的命名空间', () => {
    const { namespaces } = bootServices()

    expect(namespaces).toEqual([
      'project',
      'files',
      'gallery',
      'overview',
      'config',
      'plugins',
      'i18n',
      'appearance',
      'ai'
    ])
  })

  it('服务名唯一（重复 provide 会抛，这里提前挡住复制粘贴改名漏改）', () => {
    const names = services.map((service) => service.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('装配之后需要的服务都在注册表里', () => {
    const { rpc } = bootServices()

    // 通过一次真实调用确认注册表是通的（未知 namespace 会回 unknown-namespace）
    return expect(
      rpc.invoke({ type: 'rpc', id: 'r1', namespace: 'project', method: 'list', args: [] })
    ).resolves.toMatchObject({ ok: true })
  })

  it('plugins.core：profile 里的服务行 + 静态平台包，全部只读且有说明', async () => {
    const { rpc } = bootServices([
      {
        id: 'project',
        name: '{{NIDE_ROOT}}/packages/services/project/src/index.ts',
        kind: 'service',
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
        path: '{{NIDE_ROOT}}/packages/services/project/src/index.ts',
        description: '项目生命周期'
      }
    ])
    expect(list.filter((entry) => entry.kind === 'package')).toHaveLength(CORE_PACKAGES.length)
    expect(list.every((entry) => entry.id && entry.name && entry.path)).toBe(true)
  })

  it('装配是幂等的：同一份服务列表重复 apply 才应该失败（provide 冲突）', () => {
    const rpc = new RpcRegistry()
    const ctx = installNideContext(new Context(), {
      rpc: { register: (namespace, handlers) => rpc.register(namespace, handlers) },
      env: {
        profileDir: path.join(base, 'profile'),
        profileName: 'desktop',
        home: base,
        userDataDir: path.join(base, 'user-data'),
        appRoot: path.join(base, 'app'),
        profileRows: []
      }
    })

    projectService.apply(ctx)
    expect(() => projectService.apply(ctx)).toThrow(/already registered/)
  })
})
