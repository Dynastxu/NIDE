import { JSX, useEffect } from 'react'
import { MainApp } from '@renderer/MainApp'
import { usePluginStore } from '@renderer/stores/plugin.store'

/**
 * 主窗口的启动编排层。
 *
 * 职责只有两件，都必须在**标题栏出现之前**做完，所以放不进 MainApp：
 *  - 拉起插件视图列表（并按禁用状态过滤）
 *  - 订阅「插件启用状态变了」，以便设置窗口里改完能立刻反映到工作台
 * 窗口外观（标题栏 + 内容区）在 MainApp 里，两者分开，改外观不必碰启动时序。
 */
export default function App(): JSX.Element {
  const loaded = usePluginStore((s) => s.loaded)
  const load = usePluginStore((s) => s.load)

  // 关键：视图列表的加载必须提到这里，不能放在工具区容器里。
  // 容器只在工具区可见时才挂载 —— 一旦某个区默认隐藏，它不挂载 → 视图列表
  // 永远加载不出来 → 侧边按钮因为没有视图而不出现 → 用户再也打不开。死锁。
  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  /**
   * 设置窗口里禁用/启用插件后，主进程会广播过来。
   *
   * 必须重新拉一次视图列表：视图的过滤是在 store 写入时做的（见 plugin.store.ts），
   * 所以光知道「谁被禁用了」不够，得让 store 拿新状态重算一遍。
   *
   * 这里不区分 pluginId —— 重算是幂等的，少写一份增量逻辑就少一处能算错的地方。
   */
  useEffect(() => {
    const subscription = window.hostAPI.onPluginEnabledChanged(() => {
      void usePluginStore.getState().reload()
    })
    return () => subscription.dispose()
  }, [])

  return <MainApp />
}
