import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Loader from '@cordisjs/plugin-loader'
import { hostServices, installNideContext, type NideContext } from '@nide/kernel/context.ts'
import { RpcRegistry } from '@nide/kernel/rpc.ts'
import { projectService } from '@nide/service-project'
import { pluginsService } from '@nide/service-plugins'
import { i18nService } from '@nide/service-i18n'
import { readPatch } from '@nide/service-plugins/profile-rows.ts'
import type {} from '@nide/host/service-types.ts'

/**
 * 安装 / 卸载的端到端语义（阶段 D2）：
 * 安装 = 目录 + profile 里的「一行」，行由 loader 挂载、shim 注册 manifest；
 * 卸载 = 卸行 + 删目录 + 撤销注册。
 */
let base = ''
let source = ''
let profileDir = ''

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'nide-plugin-install-'))
  profileDir = path.join(base, 'profile')
  source = path.join(base, 'src-plugin')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.mkdirSync(source, { recursive: true })
  fs.writeFileSync(
    path.join(source, 'manifest.json'),
    JSON.stringify({ id: 'user.tmp', name: 'Tmp Plugin', version: '0.1.0' })
  )
})

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true })
})

async function setup(): Promise<{ ctx: NideContext; rpc: RpcRegistry }> {
  const rpc = new RpcRegistry()
  const ctx = installNideContext(new Context(), {
    rpc: { register: (namespace, handlers) => rpc.register(namespace, handlers) },
    env: {
      profileDir,
      profileName: 'desktop',
      home: base,
      userDataDir: path.join(base, 'user-data'),
      appRoot: path.join(base, 'app'),
      profileRows: []
    }
  })

  await ctx.plugin(hostServices({ rpc: ctx.rpc, env: ctx.hostEnv }))
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(path.join(profileDir, 'index.js')).href })

  await Promise.all(
    [projectService, pluginsService, i18nService].map((service) => ctx.plugin(service))
  )

  return { ctx, rpc }
}

function patchRows(): { id: string; dir: string }[] {
  return (readPatch(profileDir) as { insert?: { id: string; config?: { dir?: string } }[] }[])
    .flatMap((operation) => operation.insert ?? [])
    .map((row) => ({ id: row.id, dir: row.config?.dir ?? '' }))
}

describe('插件安装 = 目录 + 一行', () => {
  it('安装后：patch 有 plugin:<id> 行，插件已注册，行由 loader 挂载', async () => {
    const { rpc } = await setup()

    const response = await rpc.invoke({
      type: 'rpc',
      id: '1',
      namespace: 'plugins',
      method: 'install',
      args: [source]
    })

    expect(response).toMatchObject({ ok: true, result: { ok: true } })
    expect(patchRows()).toEqual([
      {
        id: 'plugin:user.tmp',
        dir: path.join(base, 'user-data', 'plugins', 'src-plugin')
      }
    ])
  })

  it('卸载后：行与目录一起消失，注册表为空', async () => {
    const { ctx, rpc } = await setup()

    await rpc.invoke({
      type: 'rpc',
      id: '1',
      namespace: 'plugins',
      method: 'install',
      args: [source]
    })
    expect(ctx.plugins.list().some((plugin) => plugin.id === 'user.tmp')).toBe(true)

    const removed = await rpc.invoke({
      type: 'rpc',
      id: '2',
      namespace: 'plugins',
      method: 'remove',
      args: ['user.tmp']
    })

    expect(removed).toMatchObject({ ok: true, result: { ok: true } })
    expect(patchRows()).toEqual([])
    expect(ctx.plugins.list().some((plugin) => plugin.id === 'user.tmp')).toBe(false)
    expect(fs.existsSync(path.join(base, 'user-data', 'plugins', 'src-plugin'))).toBe(false)
  })

  it('安装不存在的目录：不写行、不注册', async () => {
    const { ctx, rpc } = await setup()

    // 行能写，但 shim 读不到 manifest（安装后目录被换成坏数据）
    const response = await rpc.invoke({
      type: 'rpc',
      id: '1',
      namespace: 'plugins',
      method: 'install',
      args: [path.join(base, 'missing')]
    })

    expect(response).toMatchObject({ ok: true, result: { ok: false } })
    expect(patchRows()).toEqual([])
    expect(ctx.plugins.list()).toEqual([])
  })
})
