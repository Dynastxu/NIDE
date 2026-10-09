import { JSX } from 'react'
import { loggerFor } from '@renderer/logger'
import { useT } from '@renderer/stores/i18n.store'
import { BuiltinIcon } from '@renderer/ui/BuiltinIcon'

const logger = loggerFor('welcome')

/**
 * 欢迎窗口左下角那颗「设置」按钮。
 *
 * 单独一个组件，而不是直接写在 WelcomeApp 里：它要处理「打开窗口失败」这一条
 * 分支，而 WelcomeApp 是这一层的**装配**代码，混进一个 Promise 的 catch 会让人
 * 误以为那块还有别的状态要管。
 *
 * 打开的仍然是**全局设置**窗口：宿主目前没有项目级设置项（见 SettingsMenu 的
 * 说明），欢迎窗口这种没有项目的状态下更不该凭空造一个空的项目设置页。
 */
export function SettingsButton(): JSX.Element {
  const t = useT()

  return (
    <button
      type="button"
      onClick={() => openWindow('settings')}
      className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
    >
      <BuiltinIcon name="sliders" className="h-3.5 w-3.5" />
      <span>{t('host.welcome.settings')}</span>
    </button>
  )
}

/**
 * 打开另一个窗口（种类在 shared/window 里登记）。
 *
 * 失败只记日志：对用户来说这是「点了没反应」，弹错误框反而更吓人。真正的原因
 * （主进程没注册对应的 opener）会打在主进程控制台里。
 */
function openWindow(type: 'settings'): void {
  void window.hostAPI.window
    .open(type)
    .catch((err: unknown) => logger.error('Failed to open a window', { type, error: err }))
}
