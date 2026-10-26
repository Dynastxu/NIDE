import { useEffect, useMemo, useState, type ComponentType, type JSX } from 'react'
import { PluginHostProvider } from './PluginHostProvider'
import { useI18nStore, useT } from '@nide/client-kit/stores/i18n.store'
import type { PluginSettingsDescriptor } from '@shared/plugin-api'
import type { SettingsPageProps } from '@renderer/settings/pages'

/**
 * 构建期由 Vite 展开成一张静态映射表：
 *   { '../../../../plugins/builtin/ai-provider/src/settings/index.tsx': () => import('...') }
 *
 * 和 PluginSlot 用同一条链路：渲染进程在 Chromium 沙箱里没有 fs，也不能 import
 * 任意磁盘路径；它能加载的只有构建期打包进来的模块。设置页因此也只能是内置插件
 * 的（第三方插件目前没有 UI 加载路径）。
 */
const settingsModules = import.meta.glob(
  '../../../../plugins/builtin/*/src/settings/*.tsx'
) as Record<string, () => Promise<unknown>>

const GLOB_PREFIX = '../../../../'

function resolveSettingsLoader(
  descriptor: PluginSettingsDescriptor
): (() => Promise<unknown>) | undefined {
  const exact = `${GLOB_PREFIX}${descriptor.dir}/${descriptor.entry}`
  if (settingsModules[exact]) return settingsModules[exact]

  // 兜底：key 以 '<dir>/<entry>' 结尾也算命中，理由同 PluginSlot
  const suffix = `/${descriptor.dir}/${descriptor.entry}`
  const hit = Object.keys(settingsModules).find((key) => key.endsWith(suffix))
  return hit ? settingsModules[hit] : undefined
}

type PluginSettingsComponent = ComponentType<SettingsPageProps>

interface LoadedSettings {
  settingsId: string
  Component: PluginSettingsComponent
}

interface FailedLoad {
  settingsId: string
  message: string
}

/**
 * 插件设置页的挂载点。
 *
 * 与 PluginSlot 的差别只有外壳：设置页拿到的是 SettingsPageProps（脏标记、
 * 提交/丢弃回调），而不是视图外壳的 API。插件设置页在自己的 renderer 里可以
 * 直接 import 宿主的 UI 模块（和 demo 插件一样），这是当前“插件 UI 与宿主同包”
 * 的既有事实，不是这里引入的新能力。
 */
interface PluginSettingsSlotProps extends SettingsPageProps {
  descriptor: PluginSettingsDescriptor
}

export function PluginSettingsSlot({
  descriptor,
  ...pageProps
}: PluginSettingsSlotProps): JSX.Element {
  const [loaded, setLoaded] = useState<LoadedSettings | null>(null)
  const [failed, setFailed] = useState<FailedLoad | null>(null)
  const locale = useI18nStore((s) => s.locale)
  const t = useT()

  const syncError = useMemo<string | null>(() => {
    if (resolveSettingsLoader(descriptor)) return null

    const available = Object.keys(settingsModules)
    return [
      `没有找到设置页 ${descriptor.pluginId}/${descriptor.id} 对应的 UI 模块。`,
      `主进程给的坐标: dir=${descriptor.dir}, entry=${descriptor.entry}`,
      `拼出来的 glob key: ${GLOB_PREFIX}${descriptor.dir}/${descriptor.entry}`,
      `构建期实际打包到的 key:`,
      available.length ? available.map((k) => `  - ${k}`).join('\n') : '  (空)'
    ].join('\n')
  }, [descriptor])

  useEffect(() => {
    const load = resolveSettingsLoader(descriptor)
    if (!load) return

    let cancelled = false
    load()
      .then((mod) => {
        if (cancelled) return
        const candidate = (mod as { default?: unknown }).default ?? mod
        if (typeof candidate !== 'function') {
          setFailed({
            settingsId: descriptor.id,
            message: `设置页 ${descriptor.id} 的模块没有 default export 一个 React 组件`
          })
          return
        }
        setLoaded({ settingsId: descriptor.id, Component: candidate as PluginSettingsComponent })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setFailed({
            settingsId: descriptor.id,
            message: `加载设置页 ${descriptor.id} 失败: ${String(err)}`
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [descriptor])

  const error = syncError ?? (failed && failed.settingsId === descriptor.id ? failed.message : null)
  const Component = loaded && loaded.settingsId === descriptor.id ? loaded.Component : null

  if (error) {
    return (
      <pre className="h-full overflow-auto whitespace-pre-wrap p-6 font-mono text-[11px] leading-4 text-red-400">
        {error}
      </pre>
    )
  }

  if (!Component) {
    return <p className="p-6 text-xs text-zinc-500">{t('host.plugin.loading')}</p>
  }

  return (
    <PluginHostProvider locale={locale} t={t}>
      <Component {...pageProps} />
    </PluginHostProvider>
  )
}
