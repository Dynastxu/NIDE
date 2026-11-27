import { fileURLToPath } from 'node:url'
import type { NideContext } from '@nide/kernel/context.ts'
import manifest from '../manifest.json' with { type: 'json' }

/**
 * AI 供应商设置页（内置）。
 *
 * 与别的内置插件一样：组合行挂载这个 Cordis 插件，manifest（含设置页贡献点）
 * 在这里注册；宿主不再扫描 `plugins/` 目录。
 */
export const name = 'nide:plugin:ai-provider'
export const inject = ['plugins']

export function apply(ctx: NideContext): void {
  ctx.plugins.registerPackage(manifest, fileURLToPath(new URL('..', import.meta.url)))
}
