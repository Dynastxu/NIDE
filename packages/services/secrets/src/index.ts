import path from 'node:path'
import type { NideContext } from '../../../kernel/src/context.ts'
import { SecretVault } from './secrets.ts'

/**
 * 密钥仓服务（没有 RPC）。
 *
 * 它不是「能力」，而是给别的服务用的基础设施：AI 供应商取 key 时
 * `ctx.services.require<SecretVault>('secrets')`。刻意**不暴露任何 RPC** ——
 * 明文只在 host 内部流转，渲染进程只有「写入 / 删除 / 是否已配置」。
 */
export const secretsService = {
  name: 'nide:service:secrets',

  apply(ctx: NideContext): void {
    ctx.services.provide('secrets', new SecretVault(path.join(ctx.env.userDataDir, 'secrets')))
  }
}

/** profile 通过 `kind: service` 行指向本文件，宿主入口取 default 后 apply */
export default secretsService
