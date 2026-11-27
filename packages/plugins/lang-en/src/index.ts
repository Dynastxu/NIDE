import { fileURLToPath } from 'node:url'
import type { NideContext } from '@nide/kernel/context.ts'
import manifest from '../manifest.json' with { type: 'json' }

/**
 * English 语言包（内置）。
 *
 * 语言包不是「扫目录发现的」：组合行挂载这个插件，它把 manifest 注册给插件服务，
 * 贡献点（`contributes.locales`）随之进入 i18n 的刷新流程。
 */
export const name = 'nide:plugin:lang-en'
export const inject = ['plugins']

export function apply(ctx: NideContext): void {
  ctx.plugins.registerPackage(manifest, fileURLToPath(new URL('..', import.meta.url)))
}
