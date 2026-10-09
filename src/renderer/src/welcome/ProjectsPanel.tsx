import { JSX, useEffect, useState } from 'react'
import { loggerFor } from '@renderer/logger'
import { useT } from '@renderer/stores/i18n.store'
import { BuiltinIcon } from '@renderer/ui/BuiltinIcon'
import { ContextMenu, type ContextMenuItem } from '@renderer/ui/ContextMenu'
import type { HostMessageKey, Translator } from '@shared/i18n'
import {
  projectNameFromPath,
  type ProjectFailureReason,
  type ProjectListItem,
  type ProjectOpenResult
} from '@shared/project'

const logger = loggerFor('welcome')

/**
 * 欢迎窗口 -> 项目。
 *
 * 右上角两个动作（新建项目 / 打开），下面是**打开过的项目**列表。两者最终都落到
 * 同一件事：选一个文件夹 -> 记进列表 -> 开主窗口。差别只在系统对话框的标题与
 * 起始目录（见 main/ipc/project.ipc.ts 的 pickDirectory）。
 *
 * 列表里的数据只有主进程知道（目录还在不在要读盘），所以这里**不做乐观更新**：
 * 增删都由 IPC 的返回结果落地，宁可慢一帧也不显示一份猜出来的列表。
 */

/** 失败原因 -> 提示词条。cancelled 不在表里：用户取消不是错误，什么都不该显示 */
const FAILURE_KEYS: Record<Exclude<ProjectFailureReason, 'cancelled'>, HostMessageKey> = {
  missing: 'host.welcome.projects.error.missing',
  'not-a-directory': 'host.welcome.projects.error.not-a-directory'
}

export function ProjectsPanel(): JSX.Element {
  const t = useT()
  /** null 表示还没取到（不是空列表：空列表要显示一句引导语） */
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null)

  useEffect(() => {
    let cancelled = false

    void window.hostAPI.projects.list().then((list) => {
      if (!cancelled) setProjects(list)
    })

    return () => {
      cancelled = true
    }
  }, [])

  /**
   * 统一处理打开结果。
   *
   * 成功时**不需要**更新界面：主进程那边已经建好主窗口、拆掉这个欢迎窗口了。
   * 取消同理，只是什么都没发生。
   */
  const report = (result: ProjectOpenResult): void => {
    if (result.ok || result.reason === 'cancelled') return

    logger.warn('Failed to open a project', { reason: result.reason })
    setError(t(FAILURE_KEYS[result.reason], { path: result.path ?? '' }))
  }

  const open = (dirPath: string): void => {
    setError(null)
    void window.hostAPI.projects.open(dirPath).then(report)
  }

  const pick = (mode: 'new' | 'open'): void => {
    setError(null)
    void window.hostAPI.projects.pick(mode).then(report)
  }

  const remove = (dirPath: string): void => {
    setError(null)
    void window.hostAPI.projects.remove(dirPath).then(setProjects)
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-start justify-between gap-6 px-6 pt-6 pb-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-sm font-medium text-zinc-100">{t('host.welcome.projects.title')}</h2>
          <p className="max-w-prose text-xs leading-relaxed text-zinc-500">
            {t('host.welcome.projects.hint')}
          </p>
        </div>

        {/* 右上角两个动作。新建在前：这个窗口出现的原因是「还没有项目」，
            第一次来的用户要的是那个入口 */}
        <div className="flex shrink-0 items-center gap-2">
          <ActionButton
            icon="plus"
            label={t('host.welcome.projects.create')}
            onClick={() => pick('new')}
          />
          <ActionButton
            icon="folder"
            label={t('host.welcome.projects.open')}
            variant="primary"
            onClick={() => pick('open')}
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        {error && (
          <p
            role="alert"
            className="mb-3 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300"
          >
            {error}
          </p>
        )}

        {projects === null ? (
          <p className="text-xs text-zinc-500">{t('host.plugin.loading')}</p>
        ) : projects.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="flex flex-col gap-1">
            {projects.map((project) => (
              <ProjectRow
                key={project.path}
                project={project}
                onOpen={() => open(project.path)}
                onContextMenu={(x, y) => setMenu({ x, y, path: project.path })}
              />
            ))}
          </ul>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={buildContextMenu(
            t,
            menu.path,
            projects?.find((project) => project.path === menu.path)?.missing ?? false,
            open,
            remove
          )}
        />
      )}
    </section>
  )
}

/**
 * 列表项右键菜单的项：打开 / 从列表移除。
 *
 * 「打开」给图标，「从列表移除」不给 —— 菜单行左侧的图标位是**等宽**的（见
 * `@renderer/ui/MenuItem`），所以空着的那一行文字左边缘仍然对齐。
 */
function buildContextMenu(
  t: Translator,
  dirPath: string,
  missing: boolean,
  onOpen: (dirPath: string) => void,
  onRemove: (dirPath: string) => void
): ContextMenuItem[] {
  return [
    {
      id: 'open',
      label: t('host.welcome.projects.menu.open'),
      icon: 'folder',
      onSelect: () => onOpen(dirPath),
      disabled: missing,
      disabledReason: t('host.welcome.projects.missing')
    },
    {
      id: 'remove',
      label: t('host.welcome.projects.menu.remove'),
      onSelect: () => onRemove(dirPath),
      // 移除的只是这条记录，磁盘上的目录一个字都不动 —— 用 danger 样式会让人
      // 以为要删文件夹
      danger: false
    }
  ]
}

function ActionButton({
  icon,
  label,
  onClick,
  variant = 'default'
}: {
  icon: string
  label: string
  onClick: () => void
  variant?: 'default' | 'primary'
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex items-center gap-1.5 rounded px-3 py-1.5 text-xs transition-colors',
        variant === 'primary'
          ? 'bg-blue-600 text-white hover:bg-blue-500'
          : 'bg-zinc-700 text-zinc-100 hover:bg-zinc-600'
      ].join(' ')}
    >
      <BuiltinIcon name={icon} className="h-3.5 w-3.5" />
      <span>{label}</span>
    </button>
  )
}

function ProjectRow({
  project,
  onOpen,
  onContextMenu
}: {
  project: ProjectListItem
  onOpen: () => void
  onContextMenu: (x: number, y: number) => void
}): JSX.Element {
  const t = useT()

  return (
    <li>
      <button
        type="button"
        // 刻意**不用** disabled 属性：Chromium 不给禁用的表单控件派发任何鼠标事件，
        // 右键菜单就再也打不开了 —— 而已失效的记录恰恰只能靠右键移出列表。
        // 点它本身仍然会发 IPC，主进程回一个 missing，界面据此把原因显示出来。
        aria-disabled={project.missing}
        onClick={onOpen}
        onContextMenu={(event) => {
          event.preventDefault()
          onContextMenu(event.clientX, event.clientY)
        }}
        title={project.missing ? t('host.welcome.projects.missing') : project.path}
        className={[
          'flex w-full items-center gap-3 rounded border px-3 py-2 text-left transition-colors',
          project.missing
            ? 'cursor-not-allowed border-zinc-800 bg-zinc-900/40 text-zinc-600'
            : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-800'
        ].join(' ')}
      >
        <BuiltinIcon name="folder" className="h-4 w-4 text-zinc-500" />

        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className={[
              'truncate text-xs',
              project.missing ? 'text-zinc-500' : 'text-zinc-100'
            ].join(' ')}
          >
            {projectNameFromPath(project.path)}
          </span>
          <span className="truncate text-[11px] text-zinc-500">{project.path}</span>
        </span>

        {project.missing && (
          <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-amber-400">
            {t('host.welcome.projects.missing')}
          </span>
        )}
      </button>
    </li>
  )
}

function EmptyState(): JSX.Element {
  const t = useT()

  return (
    <div className="flex flex-col items-center gap-2 rounded border border-dashed border-zinc-800 px-6 py-10 text-center">
      <BuiltinIcon name="folder" className="h-6 w-6 text-zinc-600" />
      <p className="text-xs text-zinc-400">{t('host.welcome.projects.empty')}</p>
      <p className="max-w-sm text-[11px] leading-relaxed text-zinc-500">
        {t('host.welcome.projects.empty.hint')}
      </p>
    </div>
  )
}
