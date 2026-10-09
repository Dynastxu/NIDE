import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  PLUGIN_PREFERENCE_FILE_NAME,
  emptyPluginPreference,
  parsePluginPreference,
  setPluginEnabled as applyPluginEnabled
} from '@shared/plugin-api'
import { loggerFor } from '../logger'
import type { PluginPreference } from '@shared/plugin-api'

const logger = loggerFor('plugin-host')

/**
 * 插件启用状态的持久化。
 *
 * 落盘位置和语言偏好（`src/main/i18n/preference.ts`）一样选 userData：禁用状态要在
 * 窗口出现时就能读到（主窗口一挂载就按它过滤视图列表），而渲染进程的 localStorage
 * 在另一个进程里，主进程读不到。
 *
 * 文件里只有插件 id，没有任何插件数据 —— 宿主不因为一次勾选就去动插件目录。
 */

/** 内存镜像。首次访问时读一次，之后写盘顺手更新 */
let store: PluginPreference | null = null

function filePath(): string {
  return path.join(app.getPath('userData'), PLUGIN_PREFERENCE_FILE_NAME)
}

function readStore(): PluginPreference {
  try {
    const raw = fs.readFileSync(filePath(), 'utf-8')
    return parsePluginPreference(JSON.parse(raw))
  } catch {
    // 首次启动（文件不存在）与文件损坏走同一条：空偏好不是错误，
    // 结果是「全部启用」，和用户从没禁用过任何插件时的表现一致
    return emptyPluginPreference()
  }
}

function persist(next: PluginPreference): void {
  store = next

  const target = filePath()
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
  } catch (err) {
    // 写不进去只影响「下次启动还记得」，不该让这次启用 / 禁用失败 ——
    // 状态在本次运行内仍然是生效的（内存镜像已经更新）
    logger.error('Failed to write the plugin preference', { error: err })
  }
}

function ensureStore(): PluginPreference {
  if (!store) {
    store = readStore()
    logger.info('Plugin preference loaded', { disabled: store.disabled.length })
  }
  return store
}

/**
 * 当前被禁用的插件 id。
 *
 * 返回**副本**：调用方（IPC 层）会把它交给结构化克隆发给渲染进程，把内部数组
 * 递出去等于让一次序列化有机会改到内存镜像。
 */
export function getDisabledPlugins(): string[] {
  return [...ensureStore().disabled]
}

/**
 * 启用 / 禁用插件并落盘。
 *
 * 只做状态这一半，「广播给所有窗口」留在 IPC 层 —— 这个模块不认识窗口。
 */
export function setPluginEnabled(pluginId: string, enabled: boolean): void {
  const current = ensureStore()
  const next = applyPluginEnabled(current, pluginId, enabled)

  // 没有实际变化时不写盘：界面重复提交一份没变的草稿是常见操作
  if (next === current) return

  persist(next)
}
