import { useEffect, useState, type ComponentType, type JSX } from 'react'
import { usePluginStore } from '../stores/plugin.store'
import type { PluginViewDescriptor } from '@shared/plugin-api'

/**
 * 构建期由 Vite 展开成一张静态映射表：
 *   { '../../../../plugins/builtin/demo/src/ui/index.tsx': () => import('...') }
 *
 * 这是渲染进程加载插件 UI 的唯一途径：渲染进程在 Chromium 沙箱里没有 fs，
 * 也无法 import 任意磁盘路径；它能加载的只有「它自己的构建系统打包进来的模块」。
 *
 * 路径层数：本文件在 src/renderer/src/plugins/，renderer 的 root 是 src/renderer，
 * 所以要 4 层 ../../../../ 才到项目根。
 */
const viewModules = import.meta.glob('../../../../plugins/builtin/*/src/ui/*.tsx') as Record<
  string,
  () => Promise<unknown>
>

const GLOB_PREFIX = '../../../../'

/** 把主进程给的 { dir, entry } 还原成 glob 的 key */
function resolveViewLoader(view: PluginViewDescriptor): (() => Promise<unknown>) | undefined {
  const exact = `${GLOB_PREFIX}${view.dir}/${view.entry}`
  if (viewModules[exact]) return viewModules[exact]

  // 兜底：key 以 '<dir>/<entry>' 结尾也算命中，
  // 这样即使 GLOB_PREFIX 的层数写错，也不会整体失效。
  const suffix = `/${view.dir}/${view.entry}`
  const hit = Object.keys(viewModules).find((key) => key.endsWith(suffix))
  return hit ? viewModules[hit] : undefined
}

type PluginComponent = ComponentType<Record<string, never>>

interface PluginSlotProps {
  viewId: string
}

export function PluginSlot({ viewId }: PluginSlotProps): JSX.Element {
  const view = usePluginStore((s) => s.views.find((v) => v.id === viewId))
  const [Component, setComponent] = useState<PluginComponent | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setComponent(null)
    setError(null)

    if (!view) {
      setError(`store 里没有视图 ${viewId}`)
      return
    }

    const load = resolveViewLoader(view)
    if (!load) {
      const available = Object.keys(viewModules)
      setError(
        [
          `没有找到视图 ${view.id} 对应的 UI 模块。`,
          `主进程给的坐标: dir=${view.dir}, entry=${view.entry}`,
          `拼出来的 glob key: ${GLOB_PREFIX}${view.dir}/${view.entry}`,
          `构建期实际打包到的 key:`,
          available.length ? available.map((k) => `  - ${k}`).join('\n') : '  (空)'
        ].join('\n')
      )
      return
    }

    let cancelled = false
    load()
      .then((mod) => {
        if (cancelled) return
        const candidate = (mod as { default?: unknown }).default ?? mod
        if (typeof candidate !== 'function') {
          setError(`视图 ${view.id} 的模块没有 default export 一个 React 组件`)
          return
        }
        setComponent(() => candidate as PluginComponent)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`加载视图 ${view.id} 失败: ${String(err)}`)
      })

    return () => {
      cancelled = true
    }
  }, [view, viewId])

  if (error) {
    return (
      <pre className="h-full overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px] leading-4 text-red-400">
        {error}
      </pre>
    )
  }

  if (!Component) {
    return <div className="p-3 text-xs text-zinc-500">Loading…</div>
  }

  return <Component />
}
