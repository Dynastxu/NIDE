import { JSX, useEffect, useRef, useState } from 'react'
import { saveActiveTab } from '@renderer/editor/editor-save'
import { useT } from '@renderer/stores/i18n.store'
import { useEditorStore } from '@renderer/stores/editor.store'
import { useLayoutStore } from '@renderer/stores/layout.store'
import { BuiltinIcon } from '@renderer/ui/BuiltinIcon'
import { DropdownMenu } from '@renderer/ui/DropdownMenu'
import type { MenuItem } from '@renderer/ui/MenuItem'
import { ProjectSelector } from '@renderer/window/ProjectSelector'
import type { HostMessageKey } from '@shared/i18n'
import { HOST_COMMIT_VIEW_ID } from '@shared/plugin-api'

/**
 * 主窗口标题栏上「应用名右边那一条」。
 *
 * 它是**一格两栏**的结构，一次只显示一栏：
 *
 * ```
 * 默认：  NIDE  [☰]  [项目 ▾]
 * 点菜单： NIDE  文件  编辑
 *                ├ 关闭项目
 *                ├ 提交
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
 * ## 破坏性操作要二次确认，但确认不在这里
 *
 * 「关闭项目」与「退出」都会让当前这个窗口消失，所以两者都要先问一句。那一问
 * **不在这个组件里**，而在主进程的动作出口上（见 `main/confirm.ts` 与
 * `main/lifecycle.ts`）：确认是动作的性质，不是某个按钮的性质 —— 菜单、项目下拉、
 * 插件、以后加进来的快捷键问的必须是同一句话。这里只负责把动作发出去，
 * 并且把菜单栏收起来。
 *
 * 浮层本身仍然是 `@renderer/ui/ConfirmDialog`（portal 到 body，因此不会被这条
 * 32px 高的标题栏裁掉），只是现在由 `ui/ConfirmHost` 按主进程的请求摆出来。
 */

interface MenuGroup {
  id: string
  labelKey: HostMessageKey
  items: MenuItem[]
}

export function MainMenu(): JSX.Element {
  const t = useT()
  const showView = useLayoutStore((s) => s.showView)
  /**
   * 当前标签页有没有未落盘的改动。
   *
   * 菜单项要据此置灰：没有改动时「保存」写下去的就是磁盘上已有的那一份。选择器返回
   * 的是**布尔值**而不是那个标签页对象 —— 后者每次都是新引用，会让菜单每敲一个字
   * 就重渲染一遍（与 editor store 里 setContent 那条早退同一个理由）。
   */
  const activeDirty = useEditorStore(
    (s) => s.tabs.find((tab) => tab.path === s.activePath)?.dirty ?? false
  )
  /** false = 显示菜单按钮 + 项目下拉；true = 显示「文件 / 编辑」 */
  const [menuOpen, setMenuOpen] = useState(false)
  /** 当前展开的子菜单 id。null 表示菜单栏开着但没有任何一项展开 */
  const [expanded, setExpanded] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const closeMenu = (): void => {
    setMenuOpen(false)
    setExpanded(null)
  }

  // 关闭逻辑只在展开时挂监听：常驻的 document 级监听器是这类浮层最常见的泄漏来源。
  // 确认框不归这里管（它在 ConfirmHost 那一层），所以这一条不需要为它留例外。
  useEffect(() => {
    if (!menuOpen) return

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
  }, [menuOpen])

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
        /**
         * 保存当前标签页。
         *
         * 与 Ctrl+S、标签条「更多 -> 保存」、以及关掉一个改过的标签页时那一问的
         * 「保存」是**同一个函数**（见 editor/editor-save）：四条入口对「保存到底是
         * 什么」只该有一种理解。没有改动时置灰 —— 那时写下去的就是磁盘上已有的那一份，
         * 一个注定什么都不改的入口不如直接说明为什么按不动。
         */
        {
          id: 'save',
          label: t('host.menu.file.save'),
          icon: 'save',
          disabled: !activeDirty,
          disabledReason: t('host.menu.file.save.disabled'),
          onSelect: pick(() => void saveActiveTab())
        },
        {
          id: 'closeProject',
          label: t('host.menu.file.closeProject'),
          icon: 'close',
          /**
           * 只发动作，不在这里弹确认框：主进程收到之后会先问一句，用户拒了就什么都
           * 不发生。这样从项目下拉、插件或以后的快捷键关项目，问的是同一句话。
           */
          onSelect: pick(() => window.hostAPI.projects.close())
        },
        /**
         * 提交：**不是**可执行动作，而是「打开提交页面」。
         *
         * 页面本体是登记在视图表里的 `host.commit`（见 main/plugin-host/host-views.ts，
         * 组件在 renderer 的 git/CommitView），所以这里只声明「把哪个区切到谁」，
         * 菜单不自己画浮层 —— 那会多出一套与工具区并行的页面装配。
         *
         * 切的是**左上工具区**：提交页与文件树同属这一区，菜单选中之后该区展示提交页，
         * 左侧按钮条上与文件树相邻的那颗按钮同时变成选中态 —— 菜单与按钮条指的是
         * 同一个视图，不会出现两套「提交页」。
         *
         * 目前只有一行占位文案：选它不会提交任何东西。
         */
        {
          id: 'commit',
          label: t('host.menu.file.commit'),
          icon: 'check',
          onSelect: pick(() => showView('leftTop', HOST_COMMIT_VIEW_ID))
        },
        {
          id: 'quit',
          label: t('host.menu.file.quit'),
          icon: 'power',
          /**
           * 同样只发动作：退出确认问在主进程的 `before-quit` 上（见
           * main/lifecycle.ts），所以菜单退出、macOS 的 ⌘Q 与关掉最后一个窗口
           * 之后的自动退出共用同一问。
           */
          onSelect: pick(() => window.hostAPI.window.quit())
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
