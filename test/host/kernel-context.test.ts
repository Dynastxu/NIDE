import { Context } from 'cordis'
import { describe, expect, it } from 'vitest'
import { installNideContext } from '@nide/kernel/context.ts'
import { RpcRegistry } from '@nide/kernel/rpc.ts'

/**
 * 内核的上下文扩展。
 *
 * 阶段 A 之后这里只剩两样东西：`ctx.rpc` 与 `ctx.hostEnv`。服务本身走 Cordis 原生
 * `provide` / `inject`，不再有自建注册表 —— 所以服务名冲突、依赖缺失由 Cordis
 * 在启动期负责，这组用例只钉住「扩展挂上去了」与「原生服务能用」。
 */

function setup(): {
  ctx: ReturnType<typeof installNideContext>
  rpc: RpcRegistry
} {
  const rpc = new RpcRegistry()
  const ctx = installNideContext(new Context(), {
    rpc: { register: (namespace, handlers) => rpc.register(namespace, handlers) },
    env: {
      profileDir: '/tmp/profile',
      profileName: 'desktop',
      home: '/tmp/home',
      userDataDir: '/tmp/user-data',
      appRoot: '/tmp/app',
      profileRows: []
    }
  })

  return { ctx, rpc }
}

describe('installNideContext', () => {
  it('rpc / env 挂在上下文上，且读得到', () => {
    const { ctx } = setup()

    expect(ctx.hostEnv.profileName).toBe('desktop')
    expect(typeof ctx.rpc.register).toBe('function')
  })

  it('宿主服务走 Cordis 原生 provide / get（不再有 ctx.services）', () => {
    const { ctx } = setup()

    ctx.provide('demo', { value: 1 })
    expect((ctx.get('demo') as { value: number }).value).toBe(1)
  })

  it('inject 的服务就绪后才执行 apply（启动顺序由依赖决定）', async () => {
    const ctx = new Context()
    const seen: string[] = []

    ctx.plugin({
      name: 'consumer',
      inject: ['demo'],
      apply(inner) {
        seen.push(`consumer:${(inner.get('demo') as { value: number }).value}`)
      }
    })

    // 还没 provide：插件停在 PENDING，apply 不执行
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toEqual([])

    ctx.provide('demo', { value: 2 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(seen).toEqual(['consumer:2'])
  })

  it('ctx.rpc.register 注册到内核那张表上（transport 分发的是同一张）', async () => {
    const { ctx, rpc } = setup()

    ctx.rpc.register('demo', { ping: () => 'pong' })
    await expect(
      rpc.invoke({ type: 'rpc', id: 'r1', namespace: 'demo', method: 'ping', args: [] })
    ).resolves.toMatchObject({ ok: true, result: 'pong' })
  })

  it('扩展属性不可枚举、不可改写（服务不该改内核）', () => {
    const { ctx } = setup()

    expect(Object.keys(ctx)).not.toContain('rpc')
    expect(() => {
      ;(ctx as unknown as { rpc: unknown }).rpc = null
    }).toThrow()
  })
})
