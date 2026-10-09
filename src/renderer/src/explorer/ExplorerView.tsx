import { JSX, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getT, useT } from '@renderer/stores/i18n.store'
import {
  createProjectEntry,
  openProjectFile,
  useExplorerStore
} from '@renderer/stores/explorer.store'
import { useEditorStore } from '@renderer/stores/editor.store'
import { BuiltinIcon } from '@renderer/ui/BuiltinIcon'
import { ContextMenu } from '@renderer/ui/ContextMenu'
import { NamePromptDialog } from '@renderer/explorer/NamePromptDialog'
import {
  buildTreeRows,
  createChildVisibility,
  isMarkdownPath,
  type CreateEntryKind,
  type TreeRow
} from '@shared/project'
import type { HostMessageKey } from '@shared/i18n'
import type { DirReadFailureReason, FileTreeEntry, FileUnsupportedReason } from '@shared/project'

/**
 * 文件树（宿主内建视图，挂在左上工具区）。
 *
 * ## 渲染方式：拍平成一张行表
 *
 * 树的展开状态、过滤规则、每一层的缩进线都算完再渲染（见 buildRows），不用嵌套
 * 组件表达父子关系。这么做的理由不是「少写一层」，而是**每个节点都要知道自己是
 * 第几层、上面每一层有没有后续兄弟**（画引导线要用），嵌套组件只能靠一层层传
 * 参数把这些信息传下去，而它们其实全都能从树的形状直接算出来。
 *
 * 副作用是渲染只有一层循环：将来文件多到需要虚拟滚动时，换掉的是这张行表的消费
 * 方式，而不是树的结构。
 *
 * ## 五件事刻意如此
 *
 * 1. **逐层读**。目录内容在展开时才经 IPC 取回来（见 explorer.store）。
 * 2. **不支持的格式点得动，但不进编辑器**：点它只是**高亮这一行**，并在顶部说明
 *    为什么打不开。表现成「点不动」会让人怀疑是不是树坏了 —— 而它其实好得很。
 * 3. **缩进画辅助线**：小说项目的目录往往三四层，只靠缩进宽度和悬停底色看不出
 *    谁在谁里面。
 * 4. **名字过长时用自绘浮层显示全名**：原生 `title` 在 Windows 上要悬停约一秒才
 *    出现，而这一列窄到几乎每个文件名都被截断 —— 一个总要等的提示等于没有。
 * 5. **右键新建文件 / 文件夹**：目录 -> 建在它内部；文件 -> 建在它的同级。
 *    目标目录由主进程从被右键的条目推出来，渲染进程指定不了写入位置。
 *
 * 排序在**主进程**做（见 project-files.service 与 shared/project 的 sortTreeEntries）。
 */

/** 每一层缩进的宽度。缩进线与图标都按它定位 */
const INDENT_WIDTH = 12

/** 目录读取失败原因 -> 词条 key。写成表，避免在组件里散落三元表达式 */
const DIR_ERROR_KEYS: Record<DirReadFailureReason, HostMessageKey> = {
  'invalid-path': 'host.explorer.error.invalid-path',
  'outside-project': 'host.explorer.error.outside-project',
  'not-a-directory': 'host.explorer.error.not-a-directory',
  unreadable: 'host.explorer.error.unreadable'
}

/** 文件不可打开原因 -> 词条 key */
const FILE_REASON_KEYS: Record<FileUnsupportedReason, HostMessageKey> = {
  'not-text': 'host.explorer.file.unsupported',
  unreadable: 'host.explorer.file.unreadable',
  'too-large': 'host.explorer.file.too-large'
}

/**
 * 右键菜单当前指向谁
 */
interface ContextTarget {
  entry: FileTreeEntry
  x: number
  y: number
}

/** 正在显示名称浮层的那一行。只有名字被横向截断时才会有值 */
interface HoveredRow {
  /** 整行：浮层按它的高度与左边缘定位 */
  row: HTMLElement
  /** 名字元素：浮层左边从这里开始，好让两处文字对齐 */
  name: HTMLElement
  entry: FileTreeEntry
}

export function ExplorerView(): JSX.Element {
  const t = useT()
  const roots = useExplorerStore((s) => s.roots)
  const pinned = useExplorerStore((s) => s.pinned)
  const children = useExplorerStore((s) => s.children)
  const errors = useExplorerStore((s) => s.errors)
  const loading = useExplorerStore((s) => s.loading)
  const expanded = useExplorerStore((s) => s.expanded)
  const setRoots = useExplorerStore((s) => s.setRoots)

  const [target, setTarget] = useState<ContextTarget | null>(null)
  const [hovered, setHovered] = useState<HoveredRow | null>(null)

  /**
   * 收起浮层的延时。
   *
   * 浮层内部是可以左右滑动的（名字很长时），所以鼠标要能从那一行**移进浮层**去拖。
   * 中间会经过它的 mouseleave，立刻收掉就永远够不着滚动条 —— 留一点时间，
   * 移进浮层时再取消（见 RowTooltip 的 onMouseEnter）。
   */
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelHide = (): void => {
    if (hideTimer.current === null) return
    clearTimeout(hideTimer.current)
    hideTimer.current = null
  }

  useEffect(() => cancelHide, [])

  /**
   * 指针进入一个被截断的名字：显示名称浮层。
   *
   * 同一行重复进来时保持原引用，免得每次 mousemove 都换一个新对象。
   */
  const reportHover = (row: HTMLElement, name: HTMLElement, entry: FileTreeEntry): void => {
    cancelHide()
    setHovered((current) => (current?.row === row ? current : { row, name, entry }))
  }

  /**
   * 指针离开某个名字（或离开了它对应的浮层）。
   *
   * 收到的路径**可能不是**当前显示的那一行（鼠标从 A 直接划到 B 时，A 的离开事件
   * 会晚于 B 的进入事件到达），所以这里要自己比对 —— 否则会在刚显示 B 的浮层上
   * 排一个把它收掉的定时器。
   *
   * 收起是**延时**的：浮层内部可以左右滑动（名字很长时），鼠标要能从那一行移进去
   * 拖滚动条，中间会经过它的离开事件。
   */
  const reportHoverEnd = (path: string): void => {
    if (hovered?.entry.path !== path) return

    cancelHide()
    hideTimer.current = setTimeout(() => {
      hideTimer.current = null
      setHovered(null)
    }, 120)
  }

  /**
   * 根目录取**启动参数**里的项目路径，而不是再发一次 IPC。
   *
   * 它在首帧之前就可得（见 preload 的说明），而树的第一层读取本来就要等一次往返。
   * 传数组是因为根不止一个（临时文件夹将来是第二个，见 explorer.store）。
   */
  const projectPath = window.__NIDE_BOOT__.projectPath

  useEffect(() => {
    if (!projectPath) return
    // 换项目会重建窗口，所以这个 store 一生只 setRoots 一次
    void setRoots([projectPath])
  }, [projectPath, setRoots])

  /**
   * 「这个目录的子项该不该显示」。useMemo 是必须的：返回的是个新函数，在选择器里
   * 现造会让 zustand 认为快照一直在变。依赖里没有 children —— 可见性与子项内容无关。
   */
  const isChildVisible = useMemo(() => createChildVisibility(roots, pinned), [roots, pinned])

  const rows = useMemo(
    () =>
      buildTreeRows({
        roots,
        children,
        errors,
        loading,
        expanded,
        isChildVisible,
        labels: {
          loading: t('host.plugin.loading'),
          empty: t('host.explorer.empty'),
          error: (reason) => t(DIR_ERROR_KEYS[reason])
        }
      }),
    [roots, children, errors, loading, expanded, isChildVisible, t]
  )

  if (!projectPath) {
    // 主窗口只在有项目时才会被创建，走到这里说明启动参数丢了
    return <p className="p-3 text-xs text-zinc-500">{t('host.explorer.empty')}</p>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ExplorerNotice />

      {/*
        树两个方向都能滚：纵向是文件多，横向是名字长（行按内容铺开、不截断，
        见 EntryRow 的 min-w-max 注释）。浮层是按行的实时位置 fixed 住的，
        所以纵向一滚就要收掉 —— 横向滚动同理（名字的起点变了，浮层就对不齐了）。
      */}
      <div
        role="tree"
        aria-label={t('host.explorer.title')}
        className="nide-scrollbar min-h-0 flex-1 overflow-auto py-1"
        onScroll={() => setHovered(null)}
      >
        {rows.length === 0 ? (
          <p className="px-3 py-1.5 text-xs text-zinc-500">{t('host.plugin.loading')}</p>
        ) : (
          rows.map((row) =>
            row.kind === 'entry' ? (
              <EntryRow
                key={row.key}
                row={row}
                onContextMenu={(next) => {
                  // 右键菜单是 z-50、这层浮层是 z-60：不先收掉浮层，菜单会被它盖住
                  setHovered(null)
                  setTarget(next)
                }}
                onHoverRow={reportHover}
                onHoverRowEnd={reportHoverEnd}
              />
            ) : (
              <NoteRow key={row.key} row={row} />
            )
          )
        )}
      </div>

      {target && (
        <EntryContextMenu
          target={target}
          /* 菜单项都是「先关再执行」，所以这里只需要关 */
          onClose={() => setTarget(null)}
        />
      )}

      {hovered && (
        <NameOverlay
          row={hovered.row}
          name={hovered.name}
          entry={hovered.entry}
          /* 鼠标移进浮层时别让延时的收起把它关掉 */
          onMouseEnter={cancelHide}
          onMouseLeave={reportHoverEnd}
        />
      )}
    </div>
  )
}

/**
 * 名称浮层：把被树右边缘切掉的那个名字**原地显示全**。
 *
 * ```
 * ┌──────────────────┐   ← 树里那一行：名字铺到容器右边缘就被切住（没有省略号）
 * │  📄 文件长长长长 │
 * ├──────────────────┤   ← 悬停时盖上来的浮层（可以超出工具区）
 * │ 文件长长长长长长  │      文字左边缘与上面完全对齐
 * └──────────────────┘
 * ```
 *
 * 三条约束：
 *
 * 1. **只有名称**，与底下那一行是同一段文字 —— 不加路径、不做任何加工。
 * 2. **文字左边缘与树里那一行对齐**：浮层的盒子从名字元素的左边缘起画，且不留内边距。
 *    留了内边距就得靠猜去补偿，而两处字体一旦有半点差别，补偿就错了。
 * 3. **允许超出文件树**（它是 `fixed`，挂在视图顶层 —— 那一串祖先里有 `overflow-hidden`）。
 *    名字长到铺满窗口时才由窗口右边缘收住。
 *
 * 注意它**不是**树能不能看全的手段：那个由树自己的横向滚动负责（见 EntryRow）。
 * 浮层只解决「悬停时不用先滚过去就能读全」。
 */
function NameOverlay({
  row,
  name,
  entry,
  onMouseEnter,
  onMouseLeave
}: {
  row: HTMLElement
  /** 树里那个名字元素：浮层的左边缘与纵向位置都按它所在的那一行算 */
  name: HTMLElement
  entry: FileTreeEntry
  onMouseEnter: () => void
  /** 离开浮层时上报**自己的**路径，由上层判断是不是它当前显示的那一行 */
  onMouseLeave: (path: string) => void
}): JSX.Element {
  const [frame, setFrame] = useState<{ left: number; top: number; maxWidth: number } | null>(null)

  useLayoutEffect(() => {
    const measure = (): void => {
      const rowRect = row.getBoundingClientRect()
      const nameRect = name.getBoundingClientRect()
      const gap = 8

      setFrame({
        // 左边缘就是文字的起点：这样浮层里的字与树里的字对齐
        left: nameRect.left,
        // 纵向压在那一行上
        top: rowRect.top,
        maxWidth: Math.max(120, window.innerWidth - gap - nameRect.left)
      })
    }

    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [row, name])

  return (
    <div
      role="tooltip"
      onMouseEnter={onMouseEnter}
      onMouseLeave={() => onMouseLeave(entry.path)}
      style={
        frame
          ? {
              /*
               * 减去自己那 1px 边框：盒子的左边缘在边框外侧，而文字从边框内侧开始。
               * 不减的话浮层里的字会比树里那一行右移一像素 —— 对齐这件事差一像素也看得出来。
               */
              left: frame.left - 1,
              top: frame.top,
              maxWidth: frame.maxWidth + 2
            }
          : // 第一帧还没量到位置：先别让人看见它闪一下
            { left: 0, top: 0, visibility: 'hidden' }
      }
      className="fixed z-[60] w-max rounded border border-zinc-600 bg-zinc-900 py-[3px] text-xs text-zinc-100 shadow-lg shadow-black/60"
    >
      {/* 不换行、不截断：外面靠窗口右边缘收住，宽度够就整条显示 */}
      <span className="block whitespace-nowrap">{entry.name}</span>
    </div>
  )
}

/**
 * 打开 / 新建失败的提示条。
 *
 * 做成树顶端的一条而不是弹框：这类失败（文件被删了、没权限）是**就地**发生的，
 * 弹框要把注意力从树上拽走，还得自己处理「关了之后回到哪儿」。下一次成功操作
 * 会自动清掉它（见 openProjectFile）。
 */
function ExplorerNotice(): JSX.Element | null {
  const t = useT()
  const notice = useExplorerStore((s) => s.notice)
  const setNotice = useExplorerStore((s) => s.setNotice)

  if (!notice) return null

  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-2 border-b border-amber-900/50 bg-amber-950/40 px-2.5 py-1.5"
    >
      <p className="min-w-0 flex-1 text-[11px] leading-4 text-amber-200">{notice}</p>
      <button
        type="button"
        aria-label={t('host.editor.tab.close')}
        onClick={() => setNotice(null)}
        className="shrink-0 rounded p-0.5 text-amber-300 hover:bg-amber-900/50"
      >
        <BuiltinIcon name="close" className="h-3 w-3" />
      </button>
    </div>
  )
}

/** 行表里的一行：文件或目录 */
function EntryRow({
  row,
  onContextMenu,
  onHoverRow,
  onHoverRowEnd
}: {
  row: Extract<TreeRow, { kind: 'entry' }>
  onContextMenu: (target: ContextTarget) => void
  /** 名字被横向截断且指针停在上面时上报（交给视图那一层弹名称浮层） */
  onHoverRow: (row: HTMLElement, name: HTMLElement, entry: FileTreeEntry) => void
  /** 指针离开某个名字。带上路径，让上层能忽略「不是当前那一行」的离开事件 */
  onHoverRowEnd: (path: string) => void
}): JSX.Element {
  const t = useT()
  const { entry, depth } = row
  const expanded = useExplorerStore((s) => s.expanded[entry.path] ?? false)
  const toggle = useExplorerStore((s) => s.toggle)
  const setNotice = useExplorerStore((s) => s.setNotice)
  const activePath = useEditorStore((s) => s.activePath)

  const isDir = entry.kind === 'directory'
  const active = entry.path === activePath
  const unsupported = entry.kind === 'file' && !entry.supported ? entry.reason : null

  /**
   * 指针停在名字上：如果这一行的名字**被横向截断**了（树铺不下、要左右滑才能看全），
   * 就把整行与名字的位置报上去，由视图那一层弹一个名称浮层。
   *
   * 为什么不在这里弹：浮层要能超出工具区（见 NameOverlay 的说明），而这一行的祖先里
   * 有一层 `overflow-hidden`。用 `fixed` 定位可以脱离它，但那样就得把浮层挂在视图顶层
   * 才不会被当成这一行的子节点卷进布局 —— 所以这里只负责测量与上报。
   */
  const nameRef = useRef<HTMLSpanElement>(null)

  const onNameHover = (): void => {
    const name = nameRef.current
    if (!name) return

    /*
     * 「有没有被截断」要比的是**树的可见宽度**，不是名字元素自己的 clientWidth。
     *
     * 行现在是 `min-w-max`（铺不下就横向滚动，见下面的注释），所以名字元素本身就等于
     * 文字宽度，`scrollWidth === clientWidth` 恒成立 —— 拿它判会永远不弹。
     */
    const viewport = name.closest('[role="tree"]')
    const available = viewport instanceof HTMLElement ? viewport.clientWidth : window.innerWidth
    if (name.scrollWidth <= available) return

    const rowElement = name.closest('button')
    if (rowElement instanceof HTMLElement) onHoverRow(rowElement, name, entry)
  }

  const onNameLeave = (): void => onHoverRowEnd(entry.path)

  const onSelect = (): void => {
    if (isDir) {
      void toggle(entry.path)
      return
    }

    /*
     * 点一个打不开的文件：仍然**选中它**（高亮这一行），并把原因说清楚。
     *
     * 以前这里是「点不动」，那会让人以为树坏了 —— 实际上树读得好好的，只是这个
     * 格式宿主不解码。高亮是「我看到了，选的是这个」，提示是「它为什么进不了编辑器」。
     */
    if (unsupported) setNotice(t(FILE_REASON_KEYS[unsupported]))
    else void openProjectFile(entry)
  }

  return (
    <button
      type="button"
      role="treeitem"
      // aria-expanded 只写在目录上：文件没有「展开」这个状态
      {...(isDir ? { 'aria-expanded': expanded } : {})}
      // aria-selected 表达「当前选中的是这一行」，与「打不开」无关
      aria-selected={active}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault()
        onContextMenu({ entry, x: event.clientX, y: event.clientY })
      }}
      className={[
        /*
         * `w-max` + `min-w-full`：行按内容铺开，铺不下就交给树那一层横向滚动；铺得下时
         * 仍然占满可见宽度，好让悬停底色与选中底色铺满一整行。
         *
         * 这里刻意不用 `truncate`：省略号只是把「看不全」从一个地方挪到另一个地方，
         * 而树能左右滑之后用户至少还有机会读全。名字元素自己也因此不带截断 ——
         * 它量出来就是文字的完整宽度，浮层判「有没有被切到」要的就是这个。
         */
        'flex w-max min-w-full items-center gap-1 py-[3px] pr-2 text-left text-xs transition-colors',
        active ? 'bg-blue-600/30 text-zinc-100' : 'hover:bg-zinc-800',
        // 打不开的文件压低一档对比度：一眼能看出「这一支不进编辑器」，
        // 但仍然有正常的悬停反馈 —— 它不是坏掉的，只是不参与编辑
        !active && unsupported ? 'text-zinc-400' : 'text-zinc-300'
      ].join(' ')}
      style={{ paddingLeft: `${depth * INDENT_WIDTH + 6}px` }}
    >
      <IndentGuides guides={row.guides} />

      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-zinc-500">
        {isDir && (
          // 展开状态用同一个字形旋转表达，两种状态宽度完全一致
          <BuiltinIcon
            name="chevronDown"
            className={['h-3 w-3 transition-transform', expanded ? '' : '-rotate-90'].join(' ')}
          />
        )}
      </span>

      <BuiltinIcon
        name={isDir ? 'folder' : isMarkdownPath(entry.path) ? 'file' : 'code'}
        className={['h-3.5 w-3.5 shrink-0', isDir ? 'text-amber-400/70' : 'text-zinc-500'].join(
          ' '
        )}
      />

      {/* 不截断：宽度由文字决定，名字超长时树整体可横向滚动 */}
      <span
        ref={nameRef}
        onMouseEnter={onNameHover}
        onMouseLeave={onNameLeave}
        className={['shrink-0 whitespace-nowrap', unsupported !== null ? 'text-zinc-400' : ''].join(
          ' '
        )}
      >
        {entry.name}
      </span>
    </button>
  )
}

/** 一句说明（加载中 / 空目录 / 读失败） */
function NoteRow({ row }: { row: Extract<TreeRow, { kind: 'note' }> }): JSX.Element {
  const tone =
    row.tone === 'error' ? 'text-red-400' : row.tone === 'empty' ? 'text-zinc-600' : 'text-zinc-500'

  return (
    <p
      {...(row.tone === 'error' ? { role: 'alert' } : {})}
      // 与条目行同宽策略：铺得下占满可见宽度，铺不下跟着树一起横向滚动
      className={`w-max min-w-full py-1 pr-2 text-[11px] leading-4 ${tone}`}
      style={{ paddingLeft: `${row.depth * INDENT_WIDTH + 6}px` }}
    >
      {row.text}
    </p>
  )
}

/**
 * 缩进的辅助线。
 *
 * 每一条是等宽格子里的一条竖线。竖线连起来就是一条从上层贯下来的引导线：三四层
 * 深的时候，只靠缩进宽度和悬停底色看不出谁在谁里面。
 *
 * 用 `border-l` 而不是绝对定位的 div：竖线高度自动等于行高，不必自己同步。
 */
function IndentGuides({ guides }: { guides: boolean[] }): JSX.Element | null {
  if (guides.length === 0) return null

  return (
    <>
      {guides.map((draw, level) => (
        <span
          key={level}
          aria-hidden="true"
          className={[
            'h-4 w-3 shrink-0 border-l',
            draw ? 'border-zinc-700/60' : 'border-transparent'
          ].join(' ')}
        />
      ))}
    </>
  )
}

// ============ 右键菜单与新建 ============

/**
 * 条目的右键菜单。
 *
 * 只有一项「新建」，展开是「文件夹 / 文件」。落点由**被右键的条目**决定：目录 -> 建在
 * 它内部，文件 -> 建在它的同级。这件事由主进程从 `entry` 推导（见 project-files.service
 * 的 createProjectEntry），所以菜单不必（也没打算）让用户再选一次位置 —— 菜单上写两个
 * 名词就够了。
 */
function EntryContextMenu({
  target,
  onClose
}: {
  target: ContextTarget
  onClose: () => void
}): JSX.Element {
  const t = useT()
  const [prompt, setPrompt] = useState<CreateEntryKind | null>(null)

  const scope = target.entry.kind === 'directory' ? 'inside' : 'sibling'

  return (
    <>
      <ContextMenu
        x={target.x}
        y={target.y}
        onClose={onClose}
        items={[
          {
            id: 'new',
            label: t('host.explorer.menu.new'),
            icon: 'plus',
            items: [
              {
                id: 'newFolder',
                label: t('host.explorer.menu.newFolder'),
                icon: 'folder',
                onSelect: () => setPrompt('directory')
              },
              {
                id: 'newFile',
                label: t('host.explorer.menu.newFile'),
                icon: 'file',
                onSelect: () => setPrompt('file')
              }
            ]
          }
        ]}
      />

      {prompt && (
        <NamePromptDialog
          kind={prompt}
          scope={scope}
          onCancel={() => {
            setPrompt(null)
            onClose()
          }}
          onSubmit={async (name) => {
            const result = await createProjectEntry(prompt, target.entry.path, name)
            if (!result.ok) {
              // 留在原地：改个名字就能成功，关掉再让他右键一次是白费一次操作
              return getT()(`host.explorer.create.failed.${result.reason}` as HostMessageKey)
            }

            setPrompt(null)
            onClose()
            return null
          }}
        />
      )}
    </>
  )
}
