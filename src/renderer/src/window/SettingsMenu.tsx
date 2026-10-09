import { JSX, useEffect, useRef, useState } from 'react'
import { getBuiltinIcon } from '@renderer/layout/icons'
import { useT } from '@renderer/stores/i18n.store'
import type { HostMessageKey } from '@shared/i18n'

/**
 * 标题栏最左边那颗按钮 + 它的下拉栏。
 *
 * 为什么入口放在最小化左边：自绘标题栏上唯一「属于应用而不是窗口」的位置就是
 * 左侧；右侧三个按钮的语义已经被系统固定了，往里插一颗会让人误以为「设置」
 * 也是个窗口操作。
 *
 * 下拉栏**不是**原生菜单，而是渲染进程自己画的浮层。原生菜单在这里有三个问题：
 * 放不了图标、三个平台的样式完全不同、而且窗口一失焦就消失（和「点开一个独立
 * 设置窗口」这个用途天然冲突）。代价是「点外面关闭」「Esc 关闭」得自己实现 ——
 * 就是下面那段 effect。
 */

interface MenuItem {
  id: string
  labelKey: HostMessageKey
  /**
   * 内置图标名
   * @see BUILTIN_ICONS
   */
  icon: string
  run: () => void
}

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
      labelKey: 'host.settings.menu.global',
      icon: 'sliders',
      run: () => openWindow('settings')
    }
    /**
     * 「项目设置」在这里缺席是**刻意**的，不是漏写：宿主目前还没有「打开项目」
     * 这个概念（见 README 的「尚未实现」），没有项目时它不该出现。
     * 等打开项目落地后，在这里补一项并挂上 `visible: hasProject` 即可。
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

      {open && (
        <div
          role="menu"
          className="absolute top-full left-0 z-50 mt-1 min-w-[200px] rounded-md border border-zinc-700 bg-zinc-800 py-1 shadow-xl shadow-black/40"
        >
          {items.map((item) => (
            <MenuRow
              key={item.id}
              icon={item.icon}
              label={t(item.labelKey)}
              onSelect={() => {
                setOpen(false)
                item.run()
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 内置图标的外壳：16×16、描边继承文字颜色。
 *
 * 和 layout/ViewIcon.tsx 里那层外壳是同一个形状，但**没有**抽成公共组件：
 * 那边接受的是插件声明的任意 SVG 字符串（要走 dangerouslySetInnerHTML），
 * 这边只吃内置图标名，两者共用的只有 6 行 SVG 属性。为了这 6 行去建立一条
 * 跨模块依赖不划算。
 */
function BuiltinIcon({ name }: { name: string }): JSX.Element {
  const inner = getBuiltinIcon(name)

  if (!inner) {
    // 图标名拼错时留一个等宽的占位，避免整行文字跳一下
    console.warn(`[nide] Unknown builtin icon "${name}"`)
    return <span className="h-4 w-4 shrink-0" />
  }

  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {inner}
    </svg>
  )
}

function MenuRow({
  icon,
  label,
  onSelect
}: {
  icon: string
  label: string
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-200 transition-colors hover:bg-blue-600 hover:text-white"
    >
      <BuiltinIcon name={icon} />
      <span className="truncate">{label}</span>
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
    .catch((err: unknown) => console.error('[nide] Open window failed:', type, err))
}
