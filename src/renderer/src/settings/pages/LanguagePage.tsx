import { JSX, useEffect } from 'react'
import { useI18nStore, useT } from '@renderer/stores/i18n.store'
import type { SettingsPageProps } from '@renderer/settings/pages'

/**
 * 设置 -> 语言。
 *
 * 这一页**没有草稿**：换语言会重建整个窗口（宿主既有机制，见 main/window.ts 的
 * recreateRootWindow），而设置窗口本身就在被重建之列。所以这里点下去就是立刻
 * 生效并重启，底部的「取消」对它无效 —— 页面上明确写出来，别让用户以为
 * 取消能把语言退回去。
 *
 * 它仍然要报一次「不脏」，否则从插件页切过来时，插件页留下的脏标记会挂在这一页
 * 头上，底部「应用」会亮着却无事可做。
 */
export default function LanguagePage({
  onDirtyChange,
  registerActions
}: SettingsPageProps): JSX.Element {
  const t = useT()
  const current = useI18nStore((s) => s.locale)
  const available = useI18nStore((s) => s.available)
  const requestLocale = useI18nStore((s) => s.requestLocale)

  useEffect(() => {
    // 这一页没有草稿：报「不脏」，并把两个动作注销掉。
    // 注销是必须的 —— 否则从插件页切过来时，插件页注册的提交动作还挂着，
    // 底部「确定」会去提交一个用户已经看不见的页面
    onDirtyChange(false)
    registerActions(null, null)
  }, [onDirtyChange, registerActions])

  return (
    <section className="flex flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-zinc-100">{t('host.settings.page.language')}</h2>
        <p className="max-w-prose text-xs leading-relaxed text-zinc-400">
          {t('host.settings.language.description')}
        </p>
        <p className="text-xs text-zinc-500">{t('host.settings.language.restartHint')}</p>
      </header>

      <div className="flex flex-col gap-2">
        <span className="text-[11px] tracking-wide text-zinc-500 uppercase">
          {t('host.settings.language.current')}
        </span>

        {/* 语言列表来自主进程的语言包注册表：中文永远可选（宿主内建），
            其余每一门都对应一个装了的语言包 */}
        <ul className="flex max-w-sm flex-col gap-1">
          {available.map((descriptor) => {
            const active = descriptor.locale === current

            return (
              <li key={descriptor.locale}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    if (active) return
                    void requestLocale(descriptor.locale)
                  }}
                  className={[
                    'flex w-full items-center justify-between rounded border px-3 py-2 text-left text-xs transition-colors',
                    active
                      ? 'border-blue-500 bg-blue-600/15 text-zinc-100'
                      : 'border-zinc-700 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800'
                  ].join(' ')}
                >
                  {/* label 是语言的「自称」（简体中文 / English），刻意不翻译 */}
                  <span>{descriptor.label}</span>
                  {active && <span className="text-[11px] text-blue-400">{descriptor.locale}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
