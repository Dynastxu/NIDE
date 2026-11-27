import { fileURLToPath } from 'node:url'
import type { NideContext } from '@nide/kernel/context.ts'
import manifest from '../manifest.json' with { type: 'json' }

/**
 * demo 插件包（内置）。
 *
 * 组合行挂载这个 Cordis 插件，它在 `apply` 里把 manifest 注册给插件服务 ——
 * 目录只用来定位界面入口与客户端 bundle，不再由插件服务扫描 `plugins/`。
 */
export const name = 'nide:plugin:demo'
export const inject = ['plugins']

export function apply(ctx: NideContext): void {
  ctx.plugins.registerPackage(manifest, fileURLToPath(new URL('..', import.meta.url)))
}
