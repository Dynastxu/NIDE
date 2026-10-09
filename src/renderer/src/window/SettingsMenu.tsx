import { JSX, useEffect, useRef, useState } from 'react'
import { loggerFor } from '@renderer/logger'
import { useT } from '@renderer/stores/i18n.store'
import { BuiltinIcon } from '@renderer/ui/BuiltinIcon'
import { DropdownMenu } from '@renderer/ui/DropdownMenu'
import type { MenuItem } from '@renderer/ui/MenuItem'

const logger = loggerFor('window')

/**
 * 标题栏最右边那颗按钮 + 它的下拉栏。
 *
 * 为什么入口放在最小化左边：自绘标题栏上唯一「属于应用而不是窗口」的位置就是
 * 左侧（三点按钮的语义已经被系统固定了，往那一侧插一颗会让人误以为「设置」也是个
 * 窗口操作）；而「设置」属于当前窗口，放在右侧、贴着窗口按钮更合适。
 *
 * 下拉栏**不是**原生菜单，而是渲染进程自己画的浮层（`@renderer/ui/DropdownMenu`，
 * 与菜单栏的子菜单、右键菜单共用同一套行）。原生菜单在这里有三个问题：三个平台的
 * 样式完全不同、窗口一失焦就消失（和「点开一个独立设置窗口」这个用途天然冲突）、
 * 而且它在标题栏上的位置由系统决定。代价是「点外面关闭」「Esc 关闭」得自己实现 ——
 * 就是下面那段 effect。
 */
export function SettingsMenu(): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 只在打开时挂监听，关闭时摘掉 —— 常驻的 document 级监听器是这类浮层
  // 最常见的泄漏来源
  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const items: MenuItem[] = [
    {
      id: 'global',
      label: t('host.settings.menu.global'),
      icon: 'sliders',
      onSelect: () => {
        // 先关掉浮层再开窗口：新窗口抢到焦点时这个浮层本来也会消失，
        // 主动收掉就不会出现「菜单还挂在父窗口上」的一帧
        setOpen(false)
        openWindow('settings')
      }
    }
    /**
     * 「项目设置」在这里缺席仍然是**刻意**的：宿主现在有了「打开项目」，但还没有
     * 属于**项目**的设置项（项目 = 一个文件夹，宿主不往里面写任何东西）。
     * 等真有项目级配置（比如项目说明文件的位置）时，在这里补一项并挂上
     * `visible: hasProject` 即可 —— 那颗按钮不该在欢迎窗口那种没有项目的状态里出现。
     */
  ]

  return (
    // 自身是 no-drag：按钮和浮层都要能点，不能被标题栏的拖拽区吞掉
    <div ref={rootRef} className="relative flex h-full items-center [-webkit-app-region:no-drag]">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('host.settings.button')}
        title={t('host.settings.button')}
        onClick={() => setOpen((value) => !value)}
        className={[
          'flex h-7 w-7 items-center justify-center rounded transition-colors',
          open
            ? 'bg-zinc-700 text-zinc-100'
            : 'text-zinc-400 hover:bg-zinc-700/70 hover:text-zinc-100'
        ].join(' ')}
      >
        <BuiltinIcon name="sliders" />
      </button>

      {open && <DropdownMenu className="absolute top-full right-0 z-50 mt-1" items={items} />}
    </div>
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
