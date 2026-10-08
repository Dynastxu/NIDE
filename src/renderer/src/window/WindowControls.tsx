import { JSX, useEffect, useState } from 'react'
import { CloseIcon, MaximizeIcon, MinimizeIcon, RestoreIcon } from '@renderer/window/chrome-icons'
import { useT } from '@renderer/stores/i18n.store'
import type { WindowState } from '@shared/window'

/**
 * 自绘的三个系统按钮：最小化 / 最大化-还原 / 关闭。
 *
 * 只在**没有原生按钮**的平台上渲染（Windows / Linux）。macOS 用了
 * `titleBarStyle: 'hiddenInset'`，红黄绿三个按钮是系统画的、位置也是系统定的，
 * 我们再画一组既有重复又不可能对 —— macOS 那个绿色按钮是「全屏」而不是
 * 「最大化」，语义都对不上。由 WindowFrame 决定要不要挂载本组件。
 *
 * 状态来源有两个：
 * 1. 挂载时**同步**读一次（getState）。异步 IPC 会让第一帧把「 maximized 」
 *    画成 false，窗口明明最大化着却显示「最大化」图标，一帧的跳变肉眼可见。
 * 2. 之后靠主进程推。渲染进程算不出这些事：用户双击标题栏、拖窗口到屏幕
 *    边缘、按 Win+↑ 都会改变最大化状态，而这些动作根本不经过我们的代码。
 */
export function WindowControls(): JSX.Element {
  const t = useT()
  // 惰性初始化：getState 是同步 IPC，只该在挂载时打一次，不能每帧都调用
  const [state, setState] = useState<WindowState>(() => window.hostAPI.window.getState())

  useEffect(() => {
    const subscription = window.hostAPI.window.onStateChange(setState)
    return () => subscription.dispose()
  }, [])

  const act = (action: 'minimize' | 'toggleMaximize' | 'close'): void => {
    window.hostAPI.window.action(action)
  }

  return (
    // no-drag 必须加在这一层：标题栏其余部分是拖拽区，按钮得先把自己摘出来，
    // 否则按下去会被当成拖动窗口
    <div className="flex h-full [-webkit-app-region:no-drag]">
      <ControlButton
        label={t('host.window.minimize')}
        onClick={() => act('minimize')}
        dimmed={!state.focused}
      >
        <MinimizeIcon className="h-3 w-3" />
      </ControlButton>

      <ControlButton
        label={t(state.maximized ? 'host.window.restore' : 'host.window.maximize')}
        onClick={() => act('toggleMaximize')}
        dimmed={!state.focused}
      >
        {state.maximized ? (
          <RestoreIcon className="h-3 w-3" />
        ) : (
          <MaximizeIcon className="h-3 w-3" />
        )}
      </ControlButton>

      <ControlButton
        label={t('host.window.close')}
        onClick={() => act('close')}
        danger
        // 关闭按钮不跟着失焦变灰：它是唯一的危险操作，一灰反而更容易被当成禁用
        dimmed={false}
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </ControlButton>
    </div>
  )
}

interface ControlButtonProps {
  label: string
  onClick: () => void
  /** 关闭按钮的红色悬停；其余是中性灰 */
  danger?: boolean
  /** 窗口失焦时把图标压暗，模拟原生按钮的行为 */
  dimmed?: boolean
  children: JSX.Element
}

/**
 * 尺寸刻意是 46×32，不是随手给的圆角方块 —— 这跟 Windows 原生标题栏按钮
 * 一样宽，用户从别的程序切过来时鼠标不用重新找位置。
 *
 * 图标本身 12px（关闭 14px）：**不能更小**。这些字形只有一两条线，10px 时
 * 描边会糊成一团灰。24 的 viewBox 缩到 12px 是 0.5 倍，1.5 的线宽正好落在
 * 1px 物理像素上，在 1x 屏上也不发虚。
 */
function ControlButton({
  label,
  onClick,
  danger = false,
  dimmed = false,
  children
}: ControlButtonProps): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={[
        'flex h-full w-[46px] items-center justify-center transition-colors',
        danger ? 'hover:bg-red-600 hover:text-white' : 'hover:bg-zinc-700/70',
        dimmed ? 'text-zinc-500' : 'text-zinc-300'
      ].join(' ')}
    >
      {children}
    </button>
  )
}
