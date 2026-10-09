import { JSX, useEffect, useRef, useState } from 'react'
import { useT } from '@renderer/stores/i18n.store'
import { BuiltinIcon } from '@renderer/ui/BuiltinIcon'
import { ConfirmDialog } from '@renderer/ui/ConfirmDialog'
import { DropdownMenu } from '@renderer/ui/DropdownMenu'
import type { MenuItem } from '@renderer/ui/MenuItem'
import { ProjectSelector } from '@renderer/window/ProjectSelector'
import type { HostMessageKey } from '@shared/i18n'

/**
 * 主窗口标题栏上「应用名右边那一条」。
 *
 * 它是**一格两栏**的结构，一次只显示一栏：
 *
 * ```
 * 默认：  NIDE  [☰]  [项目 ▾]
 * 点菜单： NIDE  文件  编辑
 *                ├ 关闭项目
 *                └ 退出
 * ```
 *
 * - 菜单按钮与项目下拉是**同一栏**的内容，所以点开菜单时它们**一起让位**：菜单按钮
 *   自己也消失。它不是「切换开关」，而是这一栏的入口 —— 一个开着菜单还留在原地的
 *   按钮，会让人以为再点一下能收回，而真正的收回方式是离开。
 * - **点别处 / Esc 就变回来**（回到菜单按钮 + 项目下拉那一栏）；菜单里任意一项被选中
 *   之后同样收回。
 * - **鼠标移上去自动展开**子菜单（同时保留点击，键盘 / 触控板用户点得到）；展开
 *   「文件」时把鼠标移到「编辑」上，前者跟着收起来。
 * - 子菜单是 `@renderer/ui/DropdownMenu`：和标题栏右侧的设置下拉、列表的右键菜单
 *   共用同一套菜单行（左侧图标位，允许为空）。
 *
 * ## 为什么不用 Electron 的原生菜单
 *
 * 原生菜单栏是**系统画的**，压在我们自绘标题栏的上方，位置、配色、字体都不受宿主
 * 控制 —— 而这个窗口是刻意做成无边框 + 全自绘的（见 main/window.ts 的
 * frameOptions）。代价是上面那套开合、悬停、Esc 的逻辑得自己写。
 *
 * ## 破坏性操作要二次确认
 *
 * 「关闭项目」与「退出」都会让当前这个窗口消失，所以在真正执行之前先问一句
 * （`@renderer/ui/ConfirmDialog`，portal 到 body，因此不会被这条 32px 高的标题栏裁掉）。
 */

interface MenuGroup {
  id: string
  labelKey: HostMessageKey
  items: MenuItem[]
}

/** 正在等用户回答的那个二次确认。null 表示没有 */
type PendingConfirm = 'closeProject' | 'quit'

export function MainMenu(): JSX.Element {
  const t = useT()
  /** false = 显示菜单按钮 + 项目下拉；true = 显示「文件 / 编辑」 */
  const [menuOpen, setMenuOpen] = useState(false)
  /** 当前展开的子菜单 id。null 表示菜单栏开着但没有任何一项展开 */
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const closeMenu = (): void => {
    setMenuOpen(false)
    setExpanded(null)
  }

  // 关闭逻辑只在展开时挂监听：常驻的 document 级监听器是这类浮层最常见的泄漏来源。
  // 二次确认浮层开着时**不挂** —— 那时候该由确认框接管键盘，点外面也不该顺手把
  // 菜单栏一起收掉（收起本身没坏处，但会让「确认框还开着」这个状态看起来很怪）
  useEffect(() => {
    if (!menuOpen || confirm) return

    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return
      closeMenu()
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeMenu()
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    /**
     * 窗口失焦（点到别的应用）时也收回。
     *
     * 这一条补的是**拖拽区收不到鼠标事件**：标题栏除这一格之外都是
     * `-webkit-app-region: drag`，那些像素由系统拿去拖动窗口，渲染进程收不到
     * mousedown，所以「点标题栏空白处」这条路走不到上面的监听器。
     */
    window.addEventListener('blur', closeMenu)

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', closeMenu)
    }
  }, [menuOpen, confirm])

  /**
   * 包一层「先收起菜单栏再执行」。
   *
   * 收起放在前面有两个理由：露出确认框时底下不该还摊着一个菜单；而换窗口的动作
   * （关闭项目 / 退出）执行之后，这个菜单栏已经不属于任何还活着的窗口了。
   */
  const pick = (action: () => void) => (): void => {
    closeMenu()
    action()
  }

  const groups: MenuGroup[] = [
    {
      id: 'file',
      labelKey: 'host.menu.file',
      items: [
        {
          id: 'closeProject',
          label: t('host.menu.file.closeProject'),
          icon: 'close',
          onSelect: pick(() => setConfirm('closeProject'))
        },
        {
          id: 'quit',
          label: t('host.menu.file.quit'),
          icon: 'power',
          onSelect: pick(() => setConfirm('quit'))
        }
      ]
    },
    {
      id: 'edit',
      labelKey: 'host.menu.edit',
      /**
       * 编辑菜单**整体**尚未实现，所以每一项都置灰。
       *
       * 留着菜单而不是干脆不显示：菜单栏的结构（文件 / 编辑 / …）是用户对 IDE 的
       * 预期，缺一项会让人以为是自己没找到；置灰才是诚实的「这里以后会有东西」。
       */
      items: [
        {
          id: 'undo',
          label: t('host.menu.edit.undo'),
          icon: 'undo',
          onSelect: noop,
          disabled: true,
          disabledReason: t('host.menu.edit.notImplemented')
        },
        {
          id: 'redo',
          label: t('host.menu.edit.redo'),
          icon: 'redo',
          onSelect: noop,
          disabled: true,
          disabledReason: t('host.menu.edit.notImplemented')
        }
      ]
    }
  ]

  return (
    <div
      ref={rootRef}
      // no-drag：标题栏整条是拖拽区，而这里必须能点、能悬停
      className="relative flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
    >
      {menuOpen ? (
        <div role="menubar" className="flex h-full items-center">
          {groups.map((group) => (
            <MenuBarItem
              key={group.id}
              group={group}
              expanded={expanded === group.id}
              onHover={() => setExpanded(group.id)}
              onToggle={() => setExpanded((current) => (current === group.id ? null : group.id))}
            />
          ))}
        </div>
      ) : (
        // 菜单按钮与项目下拉是**同一栏**的内容：点开菜单时它们一起让位，
        // 菜单按钮自己也消失 —— 它不是切换开关，而是这一栏的入口
        <>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={false}
            aria-label={t('host.menu.button')}
            title={t('host.menu.button')}
            onClick={() => setMenuOpen(true)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-700/70 hover:text-zinc-100"
          >
            <BuiltinIcon name="menu" />
          </button>

          <ProjectSelector />
        </>
      )}

      {confirm === 'closeProject' && (
        <ConfirmDialog
          title={t('host.menu.file.closeProject.confirm.title')}
          message={t('host.menu.file.closeProject.confirm.message')}
          confirmLabel={t('host.menu.file.closeProject')}
          cancelLabel={t('host.dialog.cancel')}
          onConfirm={() => {
            setConfirm(null)
            window.hostAPI.projects.close()
          }}
          onCancel={() => setConfirm(null)}
        />
      )}

      {confirm === 'quit' && (
        <ConfirmDialog
          danger
          title={t('host.menu.file.quit.confirm.title')}
          message={t('host.menu.file.quit.confirm.message')}
          confirmLabel={t('host.menu.file.quit')}
          cancelLabel={t('host.dialog.cancel')}
          onConfirm={() => {
            setConfirm(null)
            window.hostAPI.window.quit()
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  )
}

/** 菜单栏上的一项（文件 / 编辑）与其下拉 */
function MenuBarItem({
  group,
  expanded,
  onHover,
  onToggle
}: {
  group: MenuGroup
  expanded: boolean
  onHover: () => void
  onToggle: () => void
}): JSX.Element {
  const t = useT()

  return (
    // onMouseEnter 挂在外层：展开的下拉也算这一项的一部分，鼠标移进下拉时不该收起来
    <div className="relative h-full" onMouseEnter={onHover}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={expanded}
        onClick={onToggle}
        className={[
          'flex h-full items-center rounded px-2 text-xs transition-colors',
          expanded ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-700/70'
        ].join(' ')}
      >
        {t(group.labelKey)}
      </button>

      {expanded && (
        <DropdownMenu
          className="absolute top-full left-0 z-50 mt-0.5"
          items={group.items}
          ariaLabel={t(group.labelKey)}
        />
      )}
    </div>
  )
}

/**
 * 尚未实现的菜单项的空实现。
 *
 * 置灰项点不到，所以它一次也不会被调用 —— 这里刻意保留一个显式函数而不是内联箭头，
 * 是为了让「这一项真的没有行为」在数据里看得见。
 */
function noop(): void {
  // 故意为空
}
