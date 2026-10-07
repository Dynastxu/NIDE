import { create } from 'zustand'
import type { PluginViewDescriptor } from '@shared/plugin-api'

interface PluginState {
  views: PluginViewDescriptor[]
  loaded: boolean

  loadViews: () => Promise<void>
}

export const usePluginStore = create<PluginState>((set) => ({
  views: [],
  loaded: false,

  loadViews: async () => {
    const views = await window.hostAPI.getPluginViews()
    set({ views, loaded: true })
  }
}))
