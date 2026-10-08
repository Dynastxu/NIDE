import { create } from 'zustand'
import type { PluginViewDescriptor } from '@shared/plugin-api'

interface PluginState {
  views: PluginViewDescriptor[]
  loaded: boolean

  loadViews: () => Promise<void>
}

/**
 * 6 个工具区的容器会同时挂载，每个都可能触发加载。
 * 这里用一个模块级 in-flight promise 去重，保证只会打一次 IPC。
 */
let inflight: Promise<void> | null = null

export const usePluginStore = create<PluginState>((set) => ({
  views: [],
  loaded: false,

  loadViews: async () => {
    if (inflight) return inflight

    inflight = window.hostAPI
      .getPluginViews()
      .then((views) => set({ views, loaded: true }))
      .finally(() => {
        inflight = null
      })

    return inflight
  }
}))
