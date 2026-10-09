import { JSX, useEffect, useRef, useState } from 'react'
import { loggerFor } from '@renderer/logger'
import { useT } from '@renderer/stores/i18n.store'
import { BuiltinIcon } from '@renderer/ui/BuiltinIcon'
import { projectNameFromPath, type ProjectListItem } from '@shared/project'

const logger = loggerFor('window')

/**
 * 标题栏上的项目下拉 —— 菜单按钮右边那一项，显示当前项目名，点开是「打开过的项目」。
 *
 * 选中另一项 = 换项目：主进程会记住它并**原地重建**这个窗口（项目路径是建窗时经
 * `additionalArguments` 固定下来的，换项目必须换窗口，reload 改不动它）。所以这里
 * 不需要在本地更新「当前项目」—— 窗口整个会换一届。
 *
 * 列表来自主进程（目录还在不在要读盘），选中失效的记录同样会得到一条失败结果，
 * 界面把它显示在弹层里，而不是静默什么都不发生。
 */
export function ProjectSelector(): JSX.Element {
  const t = useT()
  const currentPath = window.__NIDE_BOOT__.projectPath
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // 每次打开都重取一次：项目列表可能被欢迎窗口那边改过（新增 / 移除），
  // 而缓存一份只会在切换项目前后显示过期数据
  useEffect(() => {
    if (!open) return

    let cancelled = false
    void window.hostAPI.projects.list().then((list) => {
      if (!cancelled) setProjects(list)
    })

    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onBlur = (): void => setOpen(false)

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    // 窗口失焦也关掉：标题栏大部分是系统拖拽区，那里的点击渲染进程收不到
    // （同 MainMenu 的说明），所以「点到别的应用」这条路要单独兜住
    window.addEventListener('blur', onBlur)

    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const select = (project: ProjectListItem): void => {
    setError(null)

    if (project.path === currentPath) {
      setOpen(false)
      return
    }

    void window.hostAPI.projects.open(project.path).then((result) => {
      // 成功时这个窗口会被重建，界面不必再改什么；失败则留在原地说明原因
      if (result.ok || result.reason === 'cancelled') return

      logger.warn('Failed to switch project', { reason: result.reason })
      setError(
        t(
          result.reason === 'not-a-directory'
            ? 'host.welcome.projects.error.not-a-directory'
            : 'host.welcome.projects.error.missing',
          { path: result.path ?? project.path }
        )
      )
    })
  }

  /*
   * 名字从路径推导（项目 = 文件夹，见 shared/project）。没有当前项目时理论上到不了
   * 这里 —— 主窗口只在有项目时才会被创建 —— 但启动参数缺失（老版本窗口残留）时给一句
   * 占位，总比一个空按钮好。
   */
  const currentName = currentPath
    ? projectNameFromPath(currentPath)
    : t('host.project.selector.none')

  return (
    <div
      ref={rootRef}
      className="relative flex h-full shrink-0 items-center [-webkit-app-region:no-drag]"
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={currentPath ?? t('host.project.selector.none')}
        onClick={() => setOpen((value) => !value)}
        className={[
          'flex h-6 max-w-[220px] items-center gap-1 rounded px-1.5 text-xs transition-colors',
          open
            ? 'bg-zinc-700 text-zinc-100'
            : 'text-zinc-400 hover:bg-zinc-700/70 hover:text-zinc-100'
        ].join(' ')}
      >
        <BuiltinIcon name="folder" className="h-3.5 w-3.5" />
        <span className="truncate">{currentName}</span>
        <BuiltinIcon name="chevronDown" className="h-3 w-3 shrink-0" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t('host.project.selector.label')}
          className="absolute top-full left-0 z-50 mt-0.5 max-h-[60vh] min-w-[260px] overflow-y-auto rounded-md border border-zinc-700 bg-zinc-800 py-1 shadow-xl shadow-black/40"
        >
          {error && (
            <p role="alert" className="px-3 py-2 text-[11px] leading-relaxed text-red-300">
              {error}
            </p>
          )}

          {projects === null ? (
            <p className="px-3 py-1.5 text-xs text-zinc-500">{t('host.plugin.loading')}</p>
          ) : projects.length === 0 ? (
            <p className="px-3 py-1.5 text-xs text-zinc-500">{t('host.project.selector.empty')}</p>
          ) : (
            projects.map((project) => (
              <ProjectOption
                key={project.path}
                project={project}
                current={project.path === currentPath}
                onSelect={() => select(project)}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}

function ProjectOption({
  project,
  current,
  onSelect
}: {
  project: ProjectListItem
  current: boolean
  onSelect: () => void
}): JSX.Element {
  const t = useT()

  return (
    <button
      type="button"
      role="menuitem"
      // 失效的记录仍然可点：点了会得到一条「目录不存在」的说明，比一个点不动的行好排查
      onClick={onSelect}
      title={project.missing ? t('host.welcome.projects.missing') : project.path}
      className={[
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
        project.missing
          ? 'text-zinc-500 hover:bg-zinc-700/60'
          : current
            ? 'bg-blue-600/20 text-zinc-100 hover:bg-blue-600/30'
            : 'text-zinc-200 hover:bg-blue-600 hover:text-white'
      ].join(' ')}
    >
      {/* 当前项占一个等宽勾位，其余项留空 —— 否则文字左边缘会不齐 */}
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {current && <BuiltinIcon name="check" className="h-3.5 w-3.5 text-blue-400" />}
      </span>

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{projectNameFromPath(project.path)}</span>
        <span className="truncate text-[10px] text-zinc-500">{project.path}</span>
      </span>

      {project.missing && (
        <span className="shrink-0 rounded bg-zinc-700/70 px-1 text-[10px] text-amber-400">
          {t('host.welcome.projects.missing')}
        </span>
      )}
    </button>
  )
}
