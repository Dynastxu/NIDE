import path from 'node:path'
import type { NideContext } from '@nide/kernel/context.ts'
import { SecretVault } from './secrets.ts'

/**
 * 密钥仓服务（没有 RPC）。
 *
 * 它不是「能力」，而是给别的服务用的基础设施：AI 供应商 `inject: ['secrets']`，
 * 直接 `ctx.secrets`。刻意**不暴露任何 RPC** —— 明文只在 host 内部流转，
 * 渲染进程只有「写入 / 删除 / 是否已配置」。
 */
export const secretsService = {
  name: 'nide:service:secrets',
  inject: ['rpc', 'hostEnv'],

  apply(ctx: NideContext): void {
    ctx.provide('secrets', new SecretVault(path.join(ctx.hostEnv.userDataDir, 'secrets')))
  }
}

/** profile 直接列这个模块；loader 取 default 作为插件对象 */
export default secretsService
