import { createStore, type StoreApi } from 'zustand/vanilla'
import { useClientStore, useClientStores } from './client-stores'
import type { PluginViewDescriptor } from '@nide/contracts/plugin-api'

export interface PluginState {
  /**
   * **当前生效**的视图列表 —— 已经被禁用插件过滤过了。
   *
   * 过滤在**写入时**做，不在读取时做：views 的消费者（侧边按钮条、各区容器）
   * 都是直接订阅这个数组的，如果让它们在选择器里现过滤，每次都会返回一个新数组，
   * zustand v5 的 useSyncExternalStore 会认为快照一直在变而无限重渲染
   * （zone-state.ts 里那条注释就是踩过的坑）。写一次、读多处，代价只付一次。
   */
  views: PluginViewDescriptor[]
  loaded: boolean
  /** 被禁用的插件 id。设置界面改它之后要重新拉一次视图列表 */
  disabled: string[]

  /** 主窗口启动时调一次：取视图列表 + 禁用状态，两者一起过滤后再落地 */
  load: () => Promise<void>
  /** 禁用状态变化后由设置界面调用，重新拉一次视图列表 */
  reload: () => Promise<void>
}

async function fetchVisibleViews(): Promise<{ views: PluginViewDescriptor[]; disabled: string[] }> {
  const [views, disabled] = await Promise.all([
    window.hostAPI.getPluginViews(),
    window.hostAPI.getDisabledPlugins()
  ])

  const off = new Set(disabled)
  // 视图描述里带 pluginId，所以这里不必再为每个视图去查插件清单
  return { views: views.filter((view) => !off.has(view.pluginId)), disabled }
}

/** 造一张插件表（工厂）；in-flight 去重放在闭包里，实例之间互不干扰 */
export function createPluginStore(): StoreApi<PluginState> {
  let inflight: Promise<void> | null = null

  const fetchInto = (set: (partial: Partial<PluginState>) => void): Promise<void> => {
    if (inflight) return inflight

    inflight = fetchVisibleViews()
      .then(({ views, disabled }) => set({ views, disabled, loaded: true }))
      .finally(() => {
        inflight = null
      })

    return inflight
  }

  return createStore<PluginState>()((set) => ({
    views: [],
    loaded: false,
    disabled: [],

    load: () => fetchInto(set),

    /**
     * 重新拉取。**不设 loaded: false** —— 那会让整个工作台闪一下空态。
     * 保持旧视图列表直到新结果到手，切换是原子的。
     */
    reload: () => fetchInto(set)
  }))
}

/** 组件里订阅插件表的某个切片（实例来自 context，没 Provider 时用默认实例） */
export function usePluginStore<T>(selector: (state: PluginState) => T): T {
  return useClientStore(useClientStores().plugin, selector)
}
