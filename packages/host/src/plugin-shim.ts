import fs from 'node:fs'
import path from 'node:path'
import type { NideContext } from '@nide/kernel/context.ts'

/**
 * 安装式插件的**组合行入口**。
 *
 * DSH 对齐之后，插件是「包 + 一行」：安装写一行指向本 shim，`config.dir` 是插件
 * 目录（`<userData>/plugins/<dir>`）。shim 只做一件事：把目录里的 manifest 注册给
 * 插件服务 —— 发现不再靠扫描目录，行才是真相。
 *
 * 插件包自己导出 Cordis 入口时，那一行可以直接指向插件包，不需要经过这里。
 */
export const name = 'nide:plugin-shim'
export const inject = ['plugins']

export interface ShimsConfig {
  /** 插件目录（绝对路径） */
  dir?: unknown
}

export function apply(ctx: NideContext, config: ShimsConfig = {}): void {
  const dir = typeof config.dir === 'string' ? config.dir : ''
  if (!dir) throw new Error('plugin shim needs "config.dir"')

  const manifestPath = path.join(dir, 'manifest.json')
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown
  ctx.plugins.registerPackage(raw, dir, 'third-party')
}
