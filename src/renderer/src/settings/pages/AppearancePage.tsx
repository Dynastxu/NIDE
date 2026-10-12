import { JSX, useEffect, useState } from 'react'
import { useT } from '@renderer/stores/i18n.store'
import { useAppearanceStore } from '@renderer/stores/appearance.store'
import type { ThemeId } from '@shared/theme'
import type { SettingsPageProps } from '@renderer/settings/pages'

/**
 * 设置 -> 外观与行为 -> 外观。
 *
 * ## 草稿，没有预览
 *
 * 主题下拉是一份**草稿**：选了只改本页 state，界面**不会**跟着变。点「确定 / 应用」
 * 才提交给主进程，由它校验、落盘、广播；点「取消」或切走这一页就丢掉。
 *
 * 这与设置窗口的草稿模型一致（见 wiki 的「设置窗口 · 草稿模型」）。语言页是那条
 * 规则唯一的例外，而它之所以例外是因为换语言**必须重建窗口**（Monaco 的 NLS 在
 * 首帧前就固化了），点下去就已经回不了头。主题没有这个约束，所以它老老实实走草稿 ——
 * 一边预览一边攒草稿的写法会让「取消」退不退得回去这个问题变得没有答案。
 *
 * ## 样式就用组件里那套色阶
 *
 * 这一页和其他组件一样写 `bg-zinc-900` / `text-zinc-400` 这类**原始色阶**，浅色主题
 * 由 `assets/light.css` 统一翻译 —— 所以它不需要为浅色做任何特殊处理，也不可能
 * 成为"漏翻"的那一处。
 *
 * ## 「与操作系统同步」为什么是灰的
 *
 * 它现在是**禁用**状态，不是忘了接线：跟随系统的机制已经齐了（见 shared/appearance
 * 与 main/appearance 的 followSystem），缺的是把系统切换时的表现调稳。在没做到之前
 * 让这一项可选等于让用户踩坑，所以先摆成灰的。要打开它，去掉那个 `disabled` 并把值
 * 接回 store 即可。
 */
export default function AppearancePage({
  onDirtyChange,
  registerActions
}: SettingsPageProps): JSX.Element {
  const t = useT()
  const preference = useAppearanceStore((s) => s.preference)
  const available = useAppearanceStore((s) => s.available)
  const setTheme = useAppearanceStore((s) => s.setTheme)

  /** 草稿。切换页面会重新挂载本页，草稿因此自然归零 */
  const [draft, setDraft] = useState<ThemeId>(preference.theme)

  const dirty = draft !== preference.theme

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    registerActions(
      () => {
        /**
         * 提交后**不**乐观更新本页草稿：主进程会校验这个主题是否存在，广播回来的
         * 才是权威值。先跳过去再退回来是最糟的表现，而"等回执"在这条链路上只花一次
         * IPC 的时间。
         */
        void setTheme(draft)
      },
      () => setDraft(preference.theme)
    )
  }, [draft, preference.theme, setTheme, registerActions])

  return (
    <section className="flex flex-col gap-5 p-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-zinc-100">{t('host.settings.page.appearance')}</h2>
        <p className="max-w-prose text-xs leading-relaxed text-zinc-400">
          {t('host.settings.appearance.description')}
        </p>
      </header>

      <SettingRow label={t('host.settings.appearance.theme')} htmlFor="nide-settings-theme">
        <select
          id="nide-settings-theme"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="w-56 rounded border border-zinc-600 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-blue-500"
        >
          {/*
            列表为空只可能出现在一种情况下：启动参数拿到了能用的配色，但那次
            host:get-theme 还没回来（或失败了）。此时不给任何选项，而不是塞一个
            "深色主题" —— 那会和真实生效的主题对不上。
          */}
          {available.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {/*
                主题名**不翻译**（见 ThemeDescriptor.label 的说明）：它是主题自己的
                名字。以后有插件贡献的主题时，也会显示作者写的原名
              */}
              {theme.label}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label={t('host.settings.appearance.followSystem.label')}
        htmlFor="nide-settings-follow-system"
      >
        {/*
          整行只用一个 label 包住文字与方块，点文字也能勾选。
          禁用态由 `disabled` + disabled: 变体裁剪出一档灰：它只是一项"暂缓"的声明。
        */}
        <label
          htmlFor="nide-settings-follow-system"
          title={t('host.settings.appearance.followSystem.unavailable')}
          className="flex cursor-not-allowed items-center gap-2 text-xs text-zinc-500"
        >
          <input
            id="nide-settings-follow-system"
            type="checkbox"
            checked={false}
            disabled
            onChange={() => undefined}
            className="h-3.5 w-3.5 shrink-0 disabled:cursor-not-allowed disabled:accent-zinc-600"
          />
          <span>{t('host.settings.appearance.followSystem.hint')}</span>
        </label>
      </SettingRow>
    </section>
  )
}

/**
 * 一行设置项：左标签 + 右控件。
 *
 * 用 `htmlFor` 把标签连到控件上，点标签文字等于点控件 —— 复选框那一行尤其重要，
 * 否则只有那个 14px 的小方块能点。
 */
function SettingRow({
  label,
  htmlFor,
  children
}: {
  label: string
  htmlFor: string
  children: JSX.Element
}): JSX.Element {
  return (
    <div className="flex max-w-2xl flex-col gap-1">
      <div className="flex items-center gap-4">
        <label htmlFor={htmlFor} className="w-32 shrink-0 text-xs text-zinc-300">
          {label}
        </label>
        {children}
      </div>
    </div>
  )
}
