import { JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '@renderer/stores/i18n.store'
import { ContextMenu, type ContextMenuItem } from '@renderer/ui/ContextMenu'
import type { PluginDescriptor } from '@shared/plugin-api'

/**
 * 插件浏览与启用 / 禁用界面。
 *
 * 两个标签页：插件市场（占位）、已安装。
 * 已安装页是「左列表 + 右详情」：列表用复选框表示启用状态，按内置 / 用户安装
 * 分段；详情在右边。列表项右键也能启用 / 禁用 / 卸载。
 *
 * ## 它有两个宿主
 *
 * - 设置窗口的「插件」页（`mode: 'deferred'`）：勾选只改草稿，等底部按钮条提交；
 * - 欢迎窗口的「插件」页（`mode: 'immediate'`）：勾选立刻生效 —— 那个窗口没有
 *   按钮条，攒草稿等于永远提交不了。
 *
 * 所以提交方式做成一个显式的 prop，而不是让两处各抄一份界面代码：界面（列表、
 * 详情、右键菜单、底部说明）是同一套，两边的差别只有「什么时候落下去」。
 *
 * ## 启用状态是真的生效的（只作用于视图）
 * 取消勾选后点「应用」，那些插件的视图就会从工作台里消失。宿主那边只记状态，
 * **不落盘**（重启回到全部启用），也**不碰磁盘上的文件**。卸载按钮因此一律
 * 置灰 —— 让用户点一个注定失败的按钮比不给按钮更糟。这些限制都写在界面底部的
 * 说明里，不藏在代码注释里。
 */
export interface PluginsBrowserProps {
  /**
   * 提交方式。
   * - `deferred`：勾选只改草稿，由外部（设置窗口的按钮条）提交；
   * - `immediate`：勾选立即推给主进程。
   */
  mode: 'deferred' | 'immediate'
  /** 草稿模式下的「脏不脏」上报。immediate 模式没有草稿，传了也不会被调用 */
  onDirtyChange?: (dirty: boolean) => void
  /** 草稿模式下注册「提交 / 丢弃」，由外部按钮调用 */
  registerActions?: (commit: (() => void) | null, reset: (() => void) | null) => void
  /**
   * 这次提交动到了声明 `requiresRestart` 的插件时回调一次。
   *
   * 由使用方决定怎么问用户（设置窗口弹重启确认框，欢迎窗口同理）。判断留在
   * 这里是因为 `requiresRestart` 是**插件清单的字段**，只有这一层拿得到清单。
   */
  onRestartRequired?: () => void
}

export function PluginsBrowser({
  mode,
  onDirtyChange,
  registerActions,
  onRestartRequired
}: PluginsBrowserProps): JSX.Element {
  const t = useT()
  const [tab, setTab] = useState<'marketplace' | 'installed'>('installed')
  const [plugins, setPlugins] = useState<PluginDescriptor[]>([])
  const [loading, setLoading] = useState(true)

  /**
   * 已生效的状态 = 「全部启用」减去主进程报回来的禁用集合。
   *
   * 刻意**存禁用集合**而不是存一张 { id: boolean } 表：那样得为每个插件预置一个
   * true，插件列表一变（新装了一个）就会出现「表里没有它 → 默认启用」和
   * 「表里有它却是旧值」两种要靠约定兜住的情况。集合的语义没有这个歧义。
   */
  const [applied, setApplied] = useState<string[]>([])
  /** 未应用的草稿。deferred 模式下勾选框动的是它，提交后才落到 applied */
  const [draft, setDraft] = useState<string[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; pluginId: string } | null>(null)

  /** 界面上呈现（并用于算脏）的那份状态：immediate 模式没有草稿，只有已生效值 */
  const shown = mode === 'immediate' ? applied : draft

  const isEnabled = (pluginId: string, list: string[]): boolean => !list.includes(pluginId)

  const dirty = useMemo(
    () => plugins.some((plugin) => isEnabled(plugin.id, draft) !== isEnabled(plugin.id, applied)),
    [plugins, draft, applied]
  )

  // 拉清单 + 当前启用状态。两者一起取，避免先渲染一版错的勾选状态
  useEffect(() => {
    let cancelled = false

    void Promise.all([window.hostAPI.getPlugins(), window.hostAPI.getDisabledPlugins()]).then(
      ([list, off]) => {
        if (cancelled) return

        setPlugins(list)
        setApplied(off)
        setDraft(off)
        setLoading(false)
        // 默认选中第一个插件，右侧不至于空着
        setSelectedId(list[0]?.id ?? null)
      }
    )

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    // immediate 模式没有草稿，也就没有「脏」这个概念
    if (mode === 'deferred') onDirtyChange?.(dirty)
  }, [mode, dirty, onDirtyChange])

  /**
   * 把「提交」「丢弃」注册给底部按钮。
   *
   * 两个动作都从 ref 里读**当前**的 plugins / draft / applied，而不是靠闭包捕获：
   * 闭包只会在注册那一刻取值，而注册只跑一次（registerActions 引用稳定）。
   * 早先的写法依赖 [draft, applied, plugins] 反复重注册，那会连带触发
   * SettingsApp 的 setState —— 每次勾选都多一轮渲染。
   *
   * ref 的写入放在 effect 里而不是渲染期间：渲染期间改 ref 是 React 明确禁止的
   * （并发渲染下同一次渲染可能被丢弃，写进去的值就错了）。
   */
  const latest = useRef({ plugins, draft, applied })
  useEffect(() => {
    latest.current = { plugins, draft, applied }
  })

  /**
   * 把一份禁用集合落下去：逐条推给主进程，并把本地镜像换成它。
   *
   * deferred 与 immediate 两种模式共用这一条路径 —— 「哪些插件真的变了」这件事
   * 只该有一个判断处，否则迟早出现两套不一致的变更计算。
   *
   * 用 useCallback 而不是普通函数：它被注册进下面的 effect，引用每次都变的话
   * 那个 effect 会反复重跑（每次勾选都多一轮注册 + setState）。
   */
  const applyChanges = useCallback(
    (next: string[]): void => {
      const { plugins: list, applied: current } = latest.current
      const changed = list.filter(
        (plugin) => isEnabled(plugin.id, next) !== isEnabled(plugin.id, current)
      )

      if (changed.length > 0) {
        // 单向推送：宿主记状态并广播（主窗口会据此重拉视图列表，被禁用的插件
        // 视图随之消失）。不等回执 —— 真相在主进程，本地只是镜像。
        for (const plugin of changed) {
          void window.hostAPI.setPluginEnabled(plugin.id, isEnabled(plugin.id, next))
        }
        if (changed.some((plugin) => plugin.requiresRestart)) onRestartRequired?.()
      }

      setApplied(next)
      setDraft(next)
    },
    [onRestartRequired]
  )

  useEffect(() => {
    if (mode !== 'deferred' || !registerActions) return

    registerActions(
      () => applyChanges(latest.current.draft),
      () => setDraft(latest.current.applied)
    )
  }, [mode, registerActions, applyChanges])

  const selected = plugins.find((plugin) => plugin.id === selectedId) ?? null
  const builtinPlugins = plugins.filter((plugin) => plugin.builtin)
  const userPlugins = plugins.filter((plugin) => !plugin.builtin)

  /**
   * 插件 id -> 界面上的启用状态。
   *
   * 在父级算成一张查询表再往下传，而不是把「禁用集合 + 判断函数」两个东西一起
   * 穿过组件树：子组件只关心「这一行是不是勾着的」，不该知道那是个集合还是别的。
   */
  const shownEnabled: Record<string, boolean> = {}
  for (const plugin of plugins) shownEnabled[plugin.id] = !shown.includes(plugin.id)

  /** 勾选 = 从这个集合里去掉；取消勾选 = 加进去 */
  const toggle = (pluginId: string, next: boolean): void => {
    const current = latest.current.draft
    const updated = next
      ? current.filter((id) => id !== pluginId)
      : [...new Set([...current, pluginId])]

    // immediate 模式没有按钮条可等，直接落下去
    if (mode === 'immediate') applyChanges(updated)
    else setDraft(updated)
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      {/* 标签页 */}
      <div
        role="tablist"
        className="flex shrink-0 items-center gap-1 border-b border-zinc-800 px-4"
      >
        <Tab
          id="marketplace"
          label={t('host.settings.plugins.tab.marketplace')}
          active={tab === 'marketplace'}
          onSelect={() => setTab('marketplace')}
        />
        <Tab
          id="installed"
          label={t('host.settings.plugins.tab.installed')}
          active={tab === 'installed'}
          onSelect={() => setTab('installed')}
        />
      </div>

      {tab === 'marketplace' ? (
        <p className="p-6 text-xs text-zinc-500">
          {t('host.settings.plugins.marketplace.placeholder')}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 左：插件列表 */}
          <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-zinc-800">
            {loading ? (
              <p className="p-4 text-xs text-zinc-500">{t('host.plugin.loading')}</p>
            ) : plugins.length === 0 ? (
              <p className="p-4 text-xs text-zinc-500">{t('host.settings.plugins.empty')}</p>
            ) : (
              <>
                <PluginGroup
                  label={t('host.settings.plugins.group.builtin')}
                  plugins={builtinPlugins}
                  shownEnabled={shownEnabled}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onToggle={toggle}
                  onContextMenu={(x, y, pluginId) => setMenu({ x, y, pluginId })}
                />
                <PluginGroup
                  label={t('host.settings.plugins.group.user')}
                  plugins={userPlugins}
                  shownEnabled={shownEnabled}
                  selectedId={selectedId}
                  onSelect={setSelectedId}
                  onToggle={toggle}
                  onContextMenu={(x, y, pluginId) => setMenu({ x, y, pluginId })}
                />
              </>
            )}
          </div>

          {/* 右：详情 */}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {selected ? (
              <PluginDetail plugin={selected} enabled={shownEnabled[selected.id] ?? true} />
            ) : (
              <p className="p-6 text-xs text-zinc-500">
                {t('host.settings.plugins.detail.select')}
              </p>
            )}
          </div>
        </div>
      )}

      {/* 把「没落盘、不卸载」这两条限制写在界面上，而不是只写在代码注释里 */}
      <p className="shrink-0 border-t border-zinc-800 px-4 py-2 text-[11px] leading-relaxed text-zinc-500">
        {t('host.settings.plugins.note')}
      </p>

      {menu && (
        <PluginContextMenu
          x={menu.x}
          y={menu.y}
          pluginId={menu.pluginId}
          plugins={plugins}
          shownEnabled={shownEnabled}
          onToggle={toggle}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  )
}

function Tab({
  id,
  label,
  active,
  onSelect
}: {
  id: string
  label: string
  active: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      id={`settings-plugins-tab-${id}`}
      aria-selected={active}
      onClick={onSelect}
      className={[
        // border-b-2 用透明代替「不画」：否则选中与未选中会差 2px 高度，切换时整行抖动
        'border-b-2 px-3 py-2 text-xs transition-colors',
        active
          ? 'border-blue-500 text-zinc-100'
          : 'border-transparent text-zinc-400 hover:text-zinc-200'
      ].join(' ')}
    >
      {label}
    </button>
  )
}

/** 一组插件。组内为空时**整组不渲染** —— 空标题比没有标题更让人困惑 */
function PluginGroup({
  label,
  plugins,
  shownEnabled,
  selectedId,
  onSelect,
  onToggle,
  onContextMenu
}: {
  label: string
  plugins: PluginDescriptor[]
  shownEnabled: Record<string, boolean>
  selectedId: string | null
  onSelect: (id: string) => void
  onToggle: (id: string, next: boolean) => void
  onContextMenu: (x: number, y: number, pluginId: string) => void
}): JSX.Element | null {
  if (plugins.length === 0) return null

  return (
    <div className="flex flex-col py-1">
      <span className="px-3 py-1 text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
        {label}
      </span>

      {plugins.map((plugin) => (
        <PluginRow
          key={plugin.id}
          plugin={plugin}
          enabled={shownEnabled[plugin.id] ?? true}
          selected={plugin.id === selectedId}
          onSelect={() => onSelect(plugin.id)}
          onToggle={(next) => onToggle(plugin.id, next)}
          onContextMenu={(x, y) => onContextMenu(x, y, plugin.id)}
        />
      ))}
    </div>
  )
}

function PluginRow({
  plugin,
  enabled,
  selected,
  onSelect,
  onToggle,
  onContextMenu
}: {
  plugin: PluginDescriptor
  enabled: boolean
  selected: boolean
  onSelect: () => void
  onToggle: (next: boolean) => void
  onContextMenu: (x: number, y: number) => void
}): JSX.Element {
  const t = useT()

  return (
    <div
      // 整行可点选，复选框单独处理自己的点击 —— 勾选不该顺带改选中项
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault()
        onSelect()
        onContextMenu(event.clientX, event.clientY)
      }}
      className={[
        'flex cursor-default items-center gap-2 px-3 py-1.5 text-xs transition-colors',
        selected ? 'bg-blue-600/20 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800'
      ].join(' ')}
    >
      <input
        type="checkbox"
        checked={enabled}
        aria-label={`${t('host.settings.plugins.enable')}: ${plugin.name}`}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onToggle(event.target.checked)}
        className="h-3.5 w-3.5 shrink-0 accent-blue-600"
      />
      <span className={['truncate', enabled ? '' : 'text-zinc-500 line-through'].join(' ')}>
        {plugin.name}
      </span>
      {plugin.requiresRestart && (
        <span
          title={t('host.settings.plugins.detail.requiresRestart')}
          className="shrink-0 rounded bg-zinc-700/70 px-1 text-[10px] text-zinc-400"
        >
          {t('host.settings.plugins.restartBadge')}
        </span>
      )}
    </div>
  )
}

function PluginDetail({
  plugin,
  enabled
}: {
  plugin: PluginDescriptor
  enabled: boolean
}): JSX.Element {
  const t = useT()

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-zinc-100">{plugin.name}</h2>
        <p className="text-xs text-zinc-500">{plugin.id}</p>
        {!enabled && (
          <p className="text-xs text-amber-400">{t('host.settings.plugins.disabledWarning')}</p>
        )}
      </header>

      <dl className="flex flex-col gap-2 text-xs">
        <DetailRow label={t('host.settings.plugins.detail.version')} value={plugin.version} />
        <DetailRow
          label={t('host.settings.plugins.detail.source')}
          value={t(
            plugin.builtin
              ? 'host.settings.plugins.detail.source.builtin'
              : 'host.settings.plugins.detail.source.user'
          )}
        />
        <DetailRow label={t('host.settings.plugins.detail.dir')} value={plugin.dir} />
        <DetailRow
          label={t('host.settings.plugins.detail.requiresRestart')}
          value={t(
            plugin.requiresRestart
              ? 'host.settings.plugins.detail.requiresRestart.yes'
              : 'host.settings.plugins.detail.requiresRestart.no'
          )}
        />
      </dl>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] tracking-wide text-zinc-500 uppercase">
          {t('host.settings.plugins.detail.permissions')}
        </span>
        <p className="text-xs text-zinc-400">
          {plugin.permissions && plugin.permissions.length > 0
            ? plugin.permissions.join(', ')
            : t('host.settings.plugins.detail.permissions.none')}
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] tracking-wide text-zinc-500 uppercase">
          {t('host.settings.plugins.detail.views')}
        </span>
        {plugin.views && plugin.views.length > 0 ? (
          <ul className="flex flex-col gap-1 text-xs text-zinc-400">
            {plugin.views.map((view) => (
              <li key={view}>{view}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-zinc-400">{t('host.settings.plugins.detail.views.none')}</p>
        )}
      </div>

      <p className="max-w-prose text-xs leading-relaxed text-zinc-500">
        {plugin.description ?? ''}
      </p>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-zinc-500">{label}</dt>
      <dd className="min-w-0 break-all text-zinc-300">{value}</dd>
    </div>
  )
}

/**
 * 插件列表的右键菜单。
 *
 * 「卸载」一律置灰，原因分两种，提示文案也不同：
 * - 内置插件：宿主分发的一部分，删了下次启动又回来，所以根本不给这个能力；
 * - 用户插件：能力还没实现（宿主目前只在启动时扫目录，没有删除流程）。
 *
 * 把两种原因分开说，比笼统的「暂不支持」有用 —— 前者是永久设计，后者是待办。
 */
function PluginContextMenu({
  x,
  y,
  pluginId,
  plugins,
  shownEnabled,
  onToggle,
  onClose
}: {
  x: number
  y: number
  pluginId: string
  plugins: PluginDescriptor[]
  shownEnabled: Record<string, boolean>
  onToggle: (id: string, next: boolean) => void
  onClose: () => void
}): JSX.Element | null {
  const t = useT()
  const plugin = plugins.find((item) => item.id === pluginId)
  if (!plugin) return null

  const enabled = shownEnabled[pluginId] ?? true

  const items: ContextMenuItem[] = [
    {
      id: 'toggle',
      label: t(
        enabled ? 'host.settings.plugins.menu.disable' : 'host.settings.plugins.menu.enable'
      ),
      onSelect: () => onToggle(pluginId, !enabled)
    },
    {
      id: 'uninstall',
      label: t('host.settings.plugins.menu.uninstall'),
      onSelect: () => {},
      disabled: true,
      disabledReason: t(
        plugin.builtin
          ? 'host.settings.plugins.builtinUndeletable'
          : 'host.settings.plugins.notImplemented'
      ),
      danger: true
    }
  ]

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />
}
