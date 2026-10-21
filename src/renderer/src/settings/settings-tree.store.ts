import { create } from 'zustand'
import { getT } from '@renderer/stores/i18n.store'
import { loggerFor } from '@renderer/logger'
import { buildSettingsTree, type SettingsNode } from '@renderer/settings/pages'

const logger = loggerFor('settings')

/**
 * 设置树的数据源。
 *
 * 宿主自己的节点是编译期常量，插件节点要走一次 IPC（主进程按当前语言解析标题、
 * 过滤被禁用的插件）。两者在 `buildSettingsTree` 里合成同一棵树，所以设置窗口
 * 不需要知道某个节点来自谁。
 *
 * 失败时退回“只有宿主页”的树，而不是让设置窗口白屏 —— 插件设置拿不到，
 * 语言 / 外观 / 插件管理仍然可用。
 */
interface SettingsTreeState {
  tree: SettingsNode[]
  loaded: boolean
  load: () => Promise<void>
  /** 插件启用状态变化后重拉；语义与 load 相同，只是调用点不同 */
  reload: () => Promise<void>
}

let inflight: Promise<void> | null = null

async function fetchTree(): Promise<SettingsNode[]> {
  const pluginSettings = await window.hostAPI.getPluginSettings()
  return buildSettingsTree(getT(), pluginSettings)
}

export const useSettingsTreeStore = create<SettingsTreeState>((set) => {
  const run = (): Promise<void> => {
    if (inflight) return inflight

    inflight = fetchTree()
      .then((tree) => set({ tree, loaded: true }))
      .catch((err: unknown) => {
        logger.error('Failed to load plugin settings pages, falling back to host pages', {
          error: err
        })
        set({ tree: buildSettingsTree(getT(), []), loaded: true })
      })
      .finally(() => {
        inflight = null
      })

    return inflight
  }

  return {
    // 首帧就先给出宿主页，IPC 回来后替换；避免树在加载期间整个空掉
    tree: buildSettingsTree(getT(), []),
    loaded: false,
    load: run,
    reload: run
  }
})
