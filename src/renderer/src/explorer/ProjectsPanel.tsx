import { JSX, useEffect, useState } from 'react'
import { useT } from '@renderer/stores/i18n.store'
import { useExplorerStore } from '@renderer/stores/explorer.store'
import { openChapterFile } from '@renderer/explorer/chapter-actions'
import { EntryMenu } from '@renderer/entry/EntryMenu'
import { Disclosure } from '@renderer/ui/Disclosure'
import { BuiltinIcon } from '@renderer/ui/BuiltinIcon'
import type { ChapterFile, DirReadFailureReason, ProjectConfigKey } from '@shared/project'
import type { HostMessageKey } from '@shared/i18n'

/**
 * 「项目」标签页：按四个内容目录列出各自的内容。
 *
 * 目录名与绝对路径都由 `.nide/config.yml` 给 —— 界面不猜、也不写死 `chapters` 这样的
 * 字面量，用户在配置里把章节目录改成 `manuscript` 之后这里跟着变。
 *
 * **目前只有章节接了实现**：图鉴 / 伏笔 / 概述三个分类的「新建」是置灰的。
 * 置灰而不是隐藏，是因为这三项已经在计划里、位置也定了 —— 一个看得见但点不动的
 * 入口，比一个要等到功能上线才出现的入口更容易看懂现在处在哪一步。
 *
 * 列表刻意只显示**编号与标题**：那是文件里真正写着的东西。排序与拖拽都还没有，
 * 先不摆出一个做不到的样子。右键菜单倒是有了：它走的是**条目动作层**那一条
 * （新建 / 重命名 / 删除，与文件树里的是同一份），再往前加一项这个面自己的
 * 「新建章节」—— 列表里的一个文件与树里的一个文件是同一个东西，能对它做的事
 * 不该因为它在哪个面板里而被重新实现一遍。
 */
export function ProjectsPanel({
  onCreateChapter
}: {
  /** 开「新建章节」的对话框。章节号与默认文件名由调用方算（它掌握着对话框的生命周期） */
  onCreateChapter: () => void
}): JSX.Element {
  const t = useT()

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* 四个分类默认全部展开：这一页的全部内容就是这四项，收起任何一项都只是多一次点击 */}
      <Disclosure title={t(SECTION_TITLES.chapters)}>
        <ChapterSection onCreate={onCreateChapter} />
      </Disclosure>

      <PlaceholderDisclosure configKey="gallery" />
      <PlaceholderDisclosure configKey="foreshadowing" />
      <PlaceholderDisclosure configKey="overview" />
    </div>
  )
}

/** 分类显示名与配置键的对应 */
const SECTION_TITLES: Record<ProjectConfigKey, HostMessageKey> = {
  chapters: 'host.project.panel.section.chapters',
  gallery: 'host.project.panel.section.gallery',
  foreshadowing: 'host.project.panel.section.foreshadowing',
  overview: 'host.project.panel.section.overview'
}

/** 读章节目录失败的原因 -> 词条 key */
const CHAPTER_ERROR_KEYS: Record<DirReadFailureReason, HostMessageKey> = {
  'invalid-path': 'host.explorer.error.invalid-path',
  'outside-project': 'host.explorer.error.outside-project',
  'not-a-directory': 'host.explorer.error.not-a-directory',
  unreadable: 'host.explorer.error.unreadable'
}

/** 章节列表里被右键的那一行 */
interface ChapterMenu {
  file: ChapterFile
  x: number
  y: number
}

/** 章节：真正实现了的那一个分类 —— 有列表、有新建 */
function ChapterSection({ onCreate }: { onCreate: () => void }): JSX.Element {
  const t = useT()
  const config = useExplorerStore((s) => s.config)
  const chaptersDir = useExplorerStore((s) => s.chaptersDir)
  const chapters = useExplorerStore((s) => s.chapters)
  const error = useExplorerStore((s) => s.chaptersError)
  const loading = useExplorerStore((s) => s.chaptersLoading)
  const configLoading = useExplorerStore((s) => s.configLoading)
  const loadConfig = useExplorerStore((s) => s.loadConfig)
  const loadChapters = useExplorerStore((s) => s.loadChapters)
  const [menu, setMenu] = useState<ChapterMenu | null>(null)

  /*
   * 首次挂载拉一次配置；配置到手之后再拉章节列表（目录要从配置里算出来）。
   *
   * 读配置之前**不需要谁来替这一面定下项目根**：loadConfig 自己会补（见 explorer.store
   * 的 ensureRoots）。这一面是默认标签页，启动时文件树并不存在 —— 定根那一步要是只
   * 挂在文件树里，这里拿到的内容目录就永远是未知的，列表一片空白。
   */
  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  useEffect(() => {
    if (!config) return
    void loadChapters()
  }, [config, loadChapters])

  const items = chapters ?? []
  /** 目录还没定下来时不给新建入口：敲完名字才被告知「不知道建到哪儿」是白费一次输入 */
  const canCreate = chaptersDir !== null

  return (
    <>
      <CreateRow label={t('host.project.panel.new')} onClick={onCreate} disabled={!canCreate} />

      {error ? (
        <p className="px-3 py-1 text-xs text-red-400">{t(CHAPTER_ERROR_KEYS[error])}</p>
      ) : (loading || configLoading) && chapters === null ? (
        /*
         * 读配置那一段也算「在加载」。少了它，启动后会先显示一帧「这个目录里还没有
         * 章节」—— 那时章节列表**还没开始读**，而内容目录是不是空的根本还不知道。
         */
        <p className="px-3 py-1 text-xs text-zinc-500">{t('host.plugin.loading')}</p>
      ) : items.length === 0 ? (
        <p className="px-3 py-1 text-xs text-zinc-500">{t('host.project.panel.chapter.empty')}</p>
      ) : (
        items.map((file) => (
          <ChapterRow
            key={file.path}
            file={file}
            onContextMenu={(x, y) => setMenu({ file, x, y })}
          />
        ))
      )}

      {menu && (
        <EntryMenu
          x={menu.x}
          y={menu.y}
          // 列表里的每一行都是一个文件：章节就是 Markdown 文件，读的是同一份磁盘内容
          target={{ path: menu.file.path, name: menu.file.name, kind: 'file' }}
          onClose={() => setMenu(null)}
          /*
           * 这个面自己的那一项，排在共用项**前面**（见 EntryMenu 的说明）：共用块的
           * 「删除」必须留在最后。
           *
           * 「新建章节」与共用块里的「新建 -> 文件」是**两个动作**，差的正是文件建出来
           * 那一刻是不是完整的：那一项建的是空文件（先占个位置），这一项建的开头带着
           * 章节属性、建完还会打开它（见 chapter-actions.ts）。
           */
          viewItems={[
            {
              id: 'newChapter',
              label: t('host.explorer.menu.newChapter'),
              icon: 'plus',
              onSelect: onCreate,
              // 与上面那颗按钮同一条判断：目录不知道在哪儿时不给入口
              ...(canCreate
                ? {}
                : { disabled: true, disabledReason: t('host.project.panel.chapter.no-dir') })
            }
          ]}
        />
      )}
    </>
  )
}

/** 还没实现的分类 */
function PlaceholderDisclosure({
  configKey
}: {
  configKey: Exclude<ProjectConfigKey, 'chapters'>
}): JSX.Element {
  const t = useT()

  return (
    <Disclosure title={t(SECTION_TITLES[configKey])}>
      <CreateRow
        label={t('host.project.panel.new')}
        disabled
        reason={t('host.project.panel.section.notImplemented')}
      />
    </Disclosure>
  )
}

/**
 * 分类下的「新建」那一行。
 *
 * 位置固定在列表**上方**（而不是标题行里）：标题行本身是一个按钮（展开 / 收起），
 * 往按钮里再嵌一个按钮是无效 HTML，键盘焦点也会变得莫名其妙。
 */
function CreateRow({
  label,
  onClick,
  disabled = false,
  reason
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
  reason?: string
}): JSX.Element {
  return (
    <div className="px-3 py-1">
      <button
        type="button"
        disabled={disabled}
        title={reason}
        onClick={onClick}
        className={[
          'flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors',
          disabled
            ? 'cursor-not-allowed bg-zinc-800/60 text-zinc-600'
            : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
        ].join(' ')}
      >
        <BuiltinIcon name="plus" className="h-3 w-3" />
        {label}
      </button>
    </div>
  )
}

/**
 * 列表里的一章：章节号 + 标题。
 *
 * 标题取正文里的一级标题（`# 决战前夜`），没有则回落到文件名 —— 文件名是磁盘上的
 * 身份，而标题是作者给这一章起的名字，后者才是他写给人看的那个。回落顺序与文件树
 * 的判断一致：实在没有可读的标题时，能认出来的只剩文件名。
 *
 * 编号读不出来时（还没写章节属性）左侧只留一个占位符，宽度与数字一致 ——
 * 否则同一列表里各行的标题会左右错开。
 */
function ChapterRow({
  file,
  onContextMenu
}: {
  file: ChapterFile
  /** 右键这一行。坐标由行自己报，菜单由上层那一个 EntryMenu 画 */
  onContextMenu: (x: number, y: number) => void
}): JSX.Element {
  const t = useT()
  const label = file.heading ?? file.name

  return (
    <button
      type="button"
      // 文件名可能被截断，完整路径放 title —— 与文件树同一条约定
      title={file.path}
      onClick={() => void openChapterFile(file)}
      onContextMenu={(event) => {
        event.preventDefault()
        onContextMenu(event.clientX, event.clientY)
      }}
      className="flex w-full items-center gap-2 px-1 py-1 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
    >
      <span className="w-7 shrink-0 text-right font-mono text-[11px] text-zinc-500">
        {file.chapter === null ? t('host.project.panel.chapter.unnumbered') : file.chapter}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}
