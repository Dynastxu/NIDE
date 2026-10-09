import { JSX, useCallback, useState } from 'react'
import { PluginsBrowser } from '@renderer/plugins/PluginsBrowser'
import { RestartDialog } from '@renderer/settings/RestartDialog'
import { useT } from '@renderer/stores/i18n.store'
import { BuiltinIcon } from '@renderer/ui/BuiltinIcon'
import { ProjectsPanel } from '@renderer/welcome/ProjectsPanel'
import { SettingsButton } from '@renderer/welcome/SettingsButton'
import { WindowFrame } from '@renderer/window/WindowFrame'
import { useWindowTitle } from '@renderer/window/useWindowTitle'
import type { HostMessageKey } from '@shared/i18n'

/**
 * 欢迎窗口 —— 没有可用项目时的入口。
 *
 * ┌──────────────────────────────────────────────┐
 * │ 标题栏（共用窗口骨架）                          │
 * ├────────┬─────────────────────────────────────┤
 * │ 项目    │                [新建项目] [打开]      │
 * │ 插件    │  项目列表 / 插件内容                  │
 * ├────────┴─────────────────────────────────────┤
 * │ [设置]                                        │
 * └──────────────────────────────────────────────┘
 *
 * 三条约定：
 * - 左侧只有两项（项目 / 插件），都是**平级**的，没有嵌套 —— 这个窗口不承担
 *   「设置」那种多层导航的职责，真要有层级就说明它该放进设置窗口了。
 * - 右边的内容全部是复用：项目列表是本窗口自己的（它只在这一个地方出现），
 *   插件内容直接用设置里的 `PluginsBrowser`（`mode: 'immediate'`：这里没有
 *   确定 / 取消按钮条，攒草稿等于永远提交不了）。
 * - 左下角那颗「设置」是**整个窗口**的出口，所以放在底部按钮条里而不是左导航的
 *   最后一项：它不是第三个标签页（点它换的是窗口，不是右侧内容）。
 */
export default function WelcomeApp(): JSX.Element {
  const title = useWindowTitle()
  const [tab, setTab] = useState<WelcomeTabId>('projects')
  /** 插件页在欢迎窗口里是立即生效的，动到需要重启的插件时在这里问一句 */
  const [askRestart, setAskRestart] = useState(false)

  const onRestartRequired = useCallback(() => setAskRestart(true), [])

  return (
    <WindowFrame title={title}>
      {/* relative：重启提示是 absolute inset-0 的浮层，锚点必须是这一层 */}
      <div className="relative flex h-full w-full flex-col bg-zinc-900 text-zinc-200">
        <div className="flex min-h-0 flex-1">
          <WelcomeNav active={tab} onSelect={setTab} />

          <div className="min-h-0 min-w-0 flex-1">
            {tab === 'projects' ? (
              <ProjectsPanel />
            ) : (
              <PluginsBrowser mode="immediate" onRestartRequired={onRestartRequired} />
            )}
          </div>
        </div>

        <footer className="flex shrink-0 items-center border-t border-zinc-800 bg-zinc-950/40 px-3 py-1.5">
          <SettingsButton />
        </footer>

        {askRestart && (
          <RestartDialog
            onRestart={() => window.hostAPI.window.restart()}
            onLater={() => setAskRestart(false)}
          />
        )}
      </div>
    </WindowFrame>
  )
}

type WelcomeTabId = 'projects' | 'plugins'

interface WelcomeTab {
  id: WelcomeTabId
  icon: string
  labelKey: HostMessageKey
}

const WELCOME_TABS: WelcomeTab[] = [
  { id: 'projects', icon: 'folder', labelKey: 'host.welcome.nav.projects' },
  { id: 'plugins', icon: 'layers', labelKey: 'host.welcome.nav.plugins' }
]

function WelcomeNav({
  active,
  onSelect
}: {
  active: WelcomeTabId
  onSelect: (id: WelcomeTabId) => void
}): JSX.Element {
  const t = useT()

  return (
    // role=tablist + aria-orientation：屏幕阅读器要能念出「这是一组竖排标签」
    <nav
      role="tablist"
      aria-orientation="vertical"
      aria-label={t('host.welcome.nav.title')}
      className="flex w-52 shrink-0 flex-col gap-0.5 border-r border-zinc-800 bg-zinc-950/40 py-2"
    >
      {WELCOME_TABS.map((tab) => {
        const selected = tab.id === active

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(tab.id)}
            className={[
              'mx-1.5 flex items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs transition-colors',
              selected
                ? 'bg-blue-600 text-white'
                : 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100'
            ].join(' ')}
          >
            <BuiltinIcon name={tab.icon} />
            <span className="truncate">{t(tab.labelKey)}</span>
          </button>
        )
      })}
    </nav>
  )
}
