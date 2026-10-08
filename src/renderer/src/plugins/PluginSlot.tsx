import { useEffect, useMemo, useState, type ComponentType, type JSX } from 'react'
import { usePluginStore } from '../stores/plugin.store'
import { useI18nStore, useT } from '../stores/i18n.store'
import { PluginHostProvider } from './PluginHostProvider'
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

/** 异步加载的结果。带上 viewId 才能判断它是不是**当前**这个视图的 */
interface LoadedView {
  viewId: string
  Component: PluginComponent
}

interface FailedLoad {
  viewId: string
  message: string
}

interface PluginSlotProps {
  viewId: string
}

export function PluginSlot({ viewId }: PluginSlotProps): JSX.Element {
  const view = usePluginStore((s) => s.views.find((v) => v.id === viewId))
  const [loaded, setLoaded] = useState<LoadedView | null>(null)
  const [failed, setFailed] = useState<FailedLoad | null>(null)

  // 插件 UI 靠这两个值自己决定用哪套文案 —— 宿主只告诉它「现在是什么语言」
  const locale = useI18nStore((s) => s.locale)
  const t = useT()

  /**
   * 同步就能算出来的错误，**在渲染期派生**，不进 state。
   *
   * 这些以前是写在 effect 同步体里的 setState —— 那会触发级联渲染，
   * React 明确不推荐（react-hooks/set-state-in-effect）。而它们本来就是
   * 由 view 纯计算出来的，没有理由占一份 state。
   */
  const syncError = useMemo<string | null>(() => {
    if (!view) return `store 里没有视图 ${viewId}`
    if (resolveViewLoader(view)) return null

    const available = Object.keys(viewModules)
    return [
      `没有找到视图 ${view.id} 对应的 UI 模块。`,
      `主进程给的坐标: dir=${view.dir}, entry=${view.entry}`,
      `拼出来的 glob key: ${GLOB_PREFIX}${view.dir}/${view.entry}`,
      `构建期实际打包到的 key:`,
      available.length ? available.map((k) => `  - ${k}`).join('\n') : '  (空)'
    ].join('\n')
  }, [view, viewId])

  useEffect(() => {
    // 同步可知的两种失败已经由 syncError 覆盖，这里只负责真正异步的那一段。
    // setState 一律只在 promise 回调里调用 —— 那正是 effect 该干的事。
    if (!view) return
    const load = resolveViewLoader(view)
    if (!load) return

    let cancelled = false
    load()
      .then((mod) => {
        if (cancelled) return
        const candidate = (mod as { default?: unknown }).default ?? mod
        if (typeof candidate !== 'function') {
          setFailed({
            viewId: view.id,
            message: `视图 ${view.id} 的模块没有 default export 一个 React 组件`
          })
          return
        }
        setLoaded({ viewId: view.id, Component: candidate as PluginComponent })
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setFailed({ viewId: view.id, message: `加载视图 ${view.id} 失败: ${String(err)}` })
      })

    return () => {
      cancelled = true
    }
  }, [view, viewId])

  // 派生而不是重置：结果不属于当前 viewId 就当作还没加载完。
  // 真正的重置由 ToolZone 的 key={view.id} 重新挂载组件完成。
  const error = syncError ?? (failed?.viewId === viewId ? failed.message : null)
  const Component = loaded?.viewId === viewId ? loaded.Component : null

  if (error) {
    return (
      <pre className="h-full overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px] leading-4 text-red-400">
        {error}
      </pre>
    )
  }

  if (!Component) {
    return <div className="p-3 text-xs text-zinc-500">{t('host.plugin.loading')}</div>
  }

  return (
    <PluginHostProvider locale={locale} t={t}>
      <Component />
    </PluginHostProvider>
  )
}
