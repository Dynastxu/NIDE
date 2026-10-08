import { WorkbenchLayout } from '@renderer/layout/WorkbenchLayout'
import { JSX, useEffect } from 'react'
import { usePluginStore } from '@renderer/stores/plugin.store'

export default function App(): JSX.Element {
  const loaded = usePluginStore((s) => s.loaded)
  const loadViews = usePluginStore((s) => s.loadViews)

  // 关键：视图列表的加载必须提到这里，不能放在工具区容器里。
  // 容器只在工具区可见时才挂载 —— 一旦某个区默认隐藏，它不挂载 → 视图列表
  // 永远加载不出来 → 侧边按钮因为没有视图而不出现 → 用户再也打不开。死锁。
  useEffect(() => {
    if (!loaded) void loadViews()
  }, [loaded, loadViews])

  return <WorkbenchLayout />
}
