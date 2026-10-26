import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { installNideContext } from '../../packages/kernel/src/context.ts'
import { RpcRegistry } from '../../packages/kernel/src/rpc.ts'

/**
 * 内核的上下文扩展。
 *
 * 这是阶段 3 的接入点：服务包不再 import 内核，只拿 `ctx.rpc` / `ctx.services` /
 * `ctx.env`。所以这三样必须**到处都在**（服务在自己的 `apply` 里一定能拿到），
 * 而服务名冲突、依赖缺失必须在启动期就炸，不能拖到第一次 RPC。
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
      appRoot: '/tmp/app'
    }
  })

  return { ctx, rpc }
}

describe('installNideContext', () => {
  it('rpc / services / env 挂在上下文上，且服务读得到', () => {
    const { ctx } = setup()

    expect(ctx.env.profileName).toBe('desktop')
    expect(typeof ctx.rpc.register).toBe('function')

    ctx.services.provide('demo', { value: 1 })
    expect(ctx.services.require<{ value: number }>('demo').value).toBe(1)
    expect(ctx.services.has('demo')).toBe(true)
  })

  it('ctx.rpc.register 注册到内核那张表上（transport 分发的是同一张）', async () => {
    const { ctx, rpc } = setup()

    ctx.rpc.register('demo', { ping: () => 'pong' })
    await expect(
      rpc.invoke({ type: 'rpc', id: 'r1', namespace: 'demo', method: 'ping', args: [] })
    ).resolves.toMatchObject({ ok: true, result: 'pong' })
  })

  it('同名服务重复 provide 直接抛错（装配错误要在启动期暴露）', () => {
    const { ctx } = setup()
    ctx.services.provide('dup', 1)

    expect(() => ctx.services.provide('dup', 2)).toThrow(/already registered/)
  })

  it('require 未注册的服务抛错，而不是给 undefined', () => {
    const { ctx } = setup()
    expect(() => ctx.services.require('nope')).toThrow(/not registered/)
  })

  it('扩展属性不可枚举、不可改写（服务不该改内核）', () => {
    const { ctx } = setup()

    expect(Object.keys(ctx)).not.toContain('rpc')
    expect(() => {
      ;(ctx as unknown as { rpc: unknown }).rpc = null
    }).toThrow()
  })
})
