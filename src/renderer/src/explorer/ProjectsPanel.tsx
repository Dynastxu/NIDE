import { JSX, useEffect, useState } from 'react'
import { useT } from '@renderer/stores/i18n.store'
import { useExplorerStore } from '@renderer/stores/explorer.store'
import { useGalleryStore } from '@renderer/stores/gallery.store'
import { openChapterFile } from '@renderer/explorer/chapter-actions'
import { openForeshadowingFile } from '@renderer/explorer/foreshadowing-actions'
import {
  isCharacterGallery,
  openGalleryFile,
  setCharacterGalleryAction
} from '@renderer/explorer/gallery-actions'
import {
  openCreateGalleryEntryPrompt,
  openCreateGalleryPrompt
} from '@renderer/stores/entry-action.store'
import { EntryMenu } from '@renderer/entry/EntryMenu'
import { Disclosure } from '@renderer/ui/Disclosure'
import { BuiltinIcon } from '@renderer/ui/BuiltinIcon'
import type {
  ChapterFile,
  DirReadFailureReason,
  ForeshadowingFile,
  GalleryEntryFile,
  GalleryFolder,
  ProjectConfigKey
} from '@shared/project'
import { GALLERY_CONFIG_FILE_NAME } from '@shared/project'
import type { HostMessageKey } from '@shared/i18n'

/**
 * 「项目」标签页：按四个内容目录列出各自的内容。
 *
 * 目录名与绝对路径都由 `.nide/config.yml` 给 —— 界面不猜、也不写死 `chapters` 这样的
 * 字面量，用户在配置里把章节目录改成 `manuscript` 之后这里跟着变。
 *
 * **章节、伏笔与图鉴接了实现**，概述分类的「新建」是置灰的。置灰而不是隐藏，
 * 是因为这一项已经在计划里、位置也定了 —— 一个看得见但点不动的入口，比一个要等到
 * 功能上线才出现的入口更容易看懂现在处在哪一步。
 *
 * 分类之间有一点结构上的差别，这里如实呈现：章节是一堆平铺的 Markdown，伏笔是一堆
 * 平铺的 yml，而**图鉴是分区的**（见 shared/project/gallery）—— 一个图鉴 = 内容目录
 * 下的一个子目录，所以图鉴那一块比章节多一层折叠。
 *
 * 列表刻意只显示**内容里真正写着的东西**：章节显示编号与标题、图鉴条目显示第一个字段
 * 的值。排序与拖拽都还没有，先不摆出一个做不到的样子。右键菜单倒是走的是**条目动作层**
 * 那一条（新建 / 重命名 / 删除，与文件树里的是同一份），再往前加这个面自己的几项 ——
 * 列表里的一个文件与树里的一个文件是同一个东西，能对它做的事不该因为它在哪个面板里而
 * 被重新实现一遍。
 */
export function ProjectsPanel({
  onCreateChapter,
  onCreateForeshadowing
}: {
  /** 开「新建章节」的对话框。章节号与默认文件名由调用方算（它掌握着对话框的生命周期） */
  onCreateChapter: () => void
  /** 开「新建伏笔」的对话框。默认文件名由调用方算（它掌握着对话框的生命周期） */
  onCreateForeshadowing: () => void
}): JSX.Element {
  const t = useT()

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* 四个分类默认全部展开：这一页的全部内容就是这四项，收起任何一项都只是多一次点击 */}
      <Disclosure title={t(SECTION_TITLES.chapters)}>
        <ChapterSection onCreate={onCreateChapter} />
      </Disclosure>

      <Disclosure title={t(SECTION_TITLES.gallery)}>
        <GallerySection />
      </Disclosure>

      <Disclosure title={t(SECTION_TITLES.foreshadowing)}>
        <ForeshadowingSection onCreate={onCreateForeshadowing} />
      </Disclosure>

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

/** 读伏笔目录失败的原因 -> 词条 key。与章节那张表分开：说的是另一个目录 */
const FORESHADOWING_ERROR_KEYS: Record<DirReadFailureReason, HostMessageKey> = {
  'invalid-path': 'host.explorer.error.invalid-path',
  'outside-project': 'host.explorer.error.outside-project',
  'not-a-directory': 'host.project.panel.foreshadowing.no-dir',
  unreadable: 'host.project.panel.foreshadowing.failed.unreadable'
}

/** 读图鉴目录失败的原因 -> 词条 key。与上面两张表分开：说的是另一件事 */
const GALLERY_ERROR_KEYS: Record<DirReadFailureReason, HostMessageKey> = {
  'invalid-path': 'host.explorer.error.invalid-path',
  'outside-project': 'host.explorer.error.outside-project',
  'not-a-directory': 'host.project.panel.gallery.no-dir',
  unreadable: 'host.project.panel.gallery.failed.unreadable'
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

/**
 * 伏笔：内容目录里的一堆平铺 yml，每一个是一张卡片。
 *
 * 与章节那一节的差别只有「列表里显示什么」与文件格式：章节是 Markdown、显示编号与
 * 一级标题，伏笔是整份 yml、显示名称与起止章节。新建方式相同（内容与文件一起落盘，
 * 见 foreshadowing-actions）。
 */
function ForeshadowingSection({ onCreate }: { onCreate: () => void }): JSX.Element {
  const t = useT()
  const config = useExplorerStore((s) => s.config)
  const foreshadowingDir = useExplorerStore((s) => s.foreshadowingDir)
  const foreshadowing = useExplorerStore((s) => s.foreshadowing)
  const error = useExplorerStore((s) => s.foreshadowingError)
  const loading = useExplorerStore((s) => s.foreshadowingLoading)
  const configLoading = useExplorerStore((s) => s.configLoading)
  const loadConfig = useExplorerStore((s) => s.loadConfig)
  const loadForeshadowing = useExplorerStore((s) => s.loadForeshadowing)
  const [menu, setMenu] = useState<ForeshadowingMenu | null>(null)

  /*
   * 首次挂载拉一次配置；配置到手之后再拉伏笔列表（目录要从配置里算出来）。
   *
   * 与章节那一节同一条理由：读配置之前不需要谁来替这一面定下项目根，loadConfig 自己
   * 会补（见 explorer.store 的 ensureRoots）。
   */
  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  useEffect(() => {
    if (!config) return
    void loadForeshadowing()
  }, [config, loadForeshadowing])

  const items = foreshadowing ?? []
  /** 目录还没定下来时不给新建入口：敲完名字才被告知「不知道建到哪儿」是白费一次输入 */
  const canCreate = foreshadowingDir !== null

  return (
    <>
      <CreateRow label={t('host.project.panel.new')} onClick={onCreate} disabled={!canCreate} />

      {error ? (
        <p className="px-3 py-1 text-xs text-red-400">{t(FORESHADOWING_ERROR_KEYS[error])}</p>
      ) : (loading || configLoading) && foreshadowing === null ? (
        /*
         * 读配置那一段也算「在加载」：少了它，启动后会先显示一帧「这个目录里还没有
         * 伏笔」—— 那时伏笔列表**还没开始读**，而内容目录是不是空的根本还不知道。
         */
        <p className="px-3 py-1 text-xs text-zinc-500">{t('host.plugin.loading')}</p>
      ) : items.length === 0 ? (
        <p className="px-3 py-1 text-xs text-zinc-500">
          {t('host.project.panel.foreshadowing.empty')}
        </p>
      ) : (
        items.map((file) => (
          <ForeshadowingRow
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
          // 列表里的每一行都是一个文件：伏笔就是 yml 文件
          target={{ path: menu.file.path, name: menu.file.name, kind: 'file' }}
          onClose={() => setMenu(null)}
          /*
           * 与章节列表同一条约定：这个面自己的「新建」排在共用项前面，共用块的
           * 「删除」必须留在最后。
           */
          viewItems={[
            {
              id: 'newForeshadowing',
              label: t('host.explorer.menu.newForeshadowing'),
              icon: 'plus',
              onSelect: onCreate,
              ...(canCreate
                ? {}
                : {
                    disabled: true,
                    disabledReason: t('host.project.panel.foreshadowing.no-dir')
                  })
            }
          ]}
        />
      )}
    </>
  )
}

/** 伏笔列表里被右键的那一行 */
interface ForeshadowingMenu {
  file: ForeshadowingFile
  x: number
  y: number
}

/**
 * 伏笔列表里的一行：名称 + 起止章节。
 *
 * 名称取 frontmatter 里的名称字段，没有时回落到文件名（见主进程的
 * foreshadowingEntryLabel）—— 与章节列表「标题取不到就回落文件名」同一条约定。
 */
function ForeshadowingRow({
  file,
  onContextMenu
}: {
  file: ForeshadowingFile
  /** 右键这一行。坐标由行自己报，菜单由上层那一个 EntryMenu 画 */
  onContextMenu: (x: number, y: number) => void
}): JSX.Element {
  const range = chapterRange(file)

  return (
    <button
      type="button"
      // 文件名可能被截断，完整路径放 title —— 与文件树同一条约定
      title={file.path}
      onClick={() => void openForeshadowingFile(file)}
      onContextMenu={(event) => {
        event.preventDefault()
        onContextMenu(event.clientX, event.clientY)
      }}
      className="flex w-full items-center gap-2 px-1 py-1 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
    >
      <span className="min-w-0 flex-1 truncate">{file.label}</span>
      {range !== null && (
        <span className="max-w-[45%] shrink-0 truncate font-mono text-[10px] text-zinc-500">
          {range}
        </span>
      )}
    </button>
  )
}

/**
 * 起止章节在列表里的写法。
 *
 * 两端都空时给 null（不画那一格）；只有一端时原样显示那一端 —— 一条只埋下、还没写
 * 到收束的伏笔是常态，用一个占位符补另一端只会把「还没想好」说成「没有」。
 */
function chapterRange(file: ForeshadowingFile): string | null {
  const start = file.startChapter.trim()
  const end = file.endChapter.trim()

  if (start.length === 0) return end.length === 0 ? null : end
  if (end.length === 0) return start

  return `${start} → ${end}`
}

/**
 * 图鉴：内容目录下的每个子目录是一个图鉴，各自带一张字段表与一串条目。
 *
 * 与章节那一节的两点差别都来自「图鉴是分区的」这件事：
 *
 * - 多一层折叠（一个图鉴一段），因为它天然有分组；
 * - 每个分组自己的菜单里有「编辑字段」与「设为角色图鉴」—— 前者打开 `config.yml`
 *   （见 renderer/editor/GalleryConfigForm），后者改 `.nide/config.yml` 里图鉴那一段
 *   的 `characters`，也就是章节表单的出场角色从哪儿选。
 */
function GallerySection(): JSX.Element {
  const t = useT()
  const galleries = useGalleryStore((s) => s.galleries)
  const registry = useGalleryStore((s) => s.registry)
  const root = useGalleryStore((s) => s.root)
  const loading = useGalleryStore((s) => s.loading)
  const error = useGalleryStore((s) => s.error)
  const loadGalleries = useExplorerStore((s) => s.loadGalleries)

  const [galleryMenu, setGalleryMenu] = useState<GalleryMenu | null>(null)
  const [entryMenu, setEntryMenu] = useState<GalleryEntryMenu | null>(null)

  /*
   * 首次挂载读一次。项目根与配置由 loadGalleries 自己补（见 explorer.store）——
   * 与章节那一节同理：这一面是默认标签页，启动时文件树并不存在。
   */
  useEffect(() => {
    void loadGalleries()
  }, [loadGalleries])

  const items = galleries ?? []
  /** 图鉴内容目录还没定下来时不给新建入口：敲完名字才被告知「不知道建到哪儿」是白费一次输入 */
  const canCreate = root !== null

  const openNewGallery = (): void => {
    if (!root) return

    /*
     * 落点报的是**图鉴内容目录自己**（新建落在它内部）。它是不是配置里那一个由主进程
     * 核对，界面这一层只是把「我右键了谁」说清楚 —— 名字那一格借用分类的显示名，
     * 它只影响菜单文案。
     */
    openCreateGalleryPrompt({
      path: root,
      name: t('host.project.panel.section.gallery'),
      kind: 'directory'
    })
  }

  return (
    <>
      <CreateRow
        label={t('host.project.panel.gallery.new')}
        onClick={openNewGallery}
        disabled={!canCreate}
        reason={t('host.project.panel.gallery.no-dir')}
      />

      {error ? (
        <p className="px-3 py-1 text-xs text-red-400">{t(GALLERY_ERROR_KEYS[error])}</p>
      ) : galleries === null || loading ? (
        <p className="px-3 py-1 text-xs text-zinc-500">{t('host.plugin.loading')}</p>
      ) : items.length === 0 ? (
        <p className="px-3 py-1 text-xs text-zinc-500">{t('host.project.panel.gallery.empty')}</p>
      ) : (
        items.map((gallery) => (
          <Disclosure
            key={gallery.path}
            summary={gallery.entries.length > 0 ? gallery.entries.length : undefined}
            title={
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{gallery.name}</span>
                {/* 角色图鉴是章节表单的出场角色来源，值得在列表里认出来 */}
                {
                  <span className="shrink-0 rounded bg-zinc-700 px-1 py-0.5 text-[10px] text-zinc-300">
                    {t(
                      isCharacterGallery(gallery, registry)
                        ? 'host.project.panel.gallery.characters'
                        : 'host.project.panel.section.gallery'
                    )}
                  </span>
                }
              </span>
            }
            onContextMenu={(event) => {
              setGalleryMenu({ gallery, x: event.clientX, y: event.clientY })
            }}
          >
            <CreateRow
              label={t('host.project.panel.gallery.newEntry')}
              onClick={() =>
                openCreateGalleryEntryPrompt({
                  path: gallery.path,
                  name: gallery.name,
                  kind: 'directory'
                })
              }
            />

            {gallery.error ? (
              <p className="px-3 py-1 text-xs text-red-400">
                {t(GALLERY_ERROR_KEYS[gallery.error])}
              </p>
            ) : gallery.entries.length === 0 ? (
              <p className="px-3 py-1 text-xs text-zinc-500">
                {t('host.project.panel.gallery.entry.empty')}
              </p>
            ) : (
              gallery.entries.map((entry) => (
                <GalleryEntryRow
                  key={entry.path}
                  entry={entry}
                  onContextMenu={(x, y) => setEntryMenu({ entry, x, y })}
                />
              ))
            )}
          </Disclosure>
        ))
      )}

      {galleryMenu && (
        <EntryMenu
          x={galleryMenu.x}
          y={galleryMenu.y}
          // 一个图鉴在磁盘上就是一个目录：能对它做的事与树里的一个目录完全相同
          target={{
            path: galleryMenu.gallery.path,
            name: galleryMenu.gallery.name,
            kind: 'directory'
          }}
          onClose={() => setGalleryMenu(null)}
          viewItems={[
            {
              id: 'newGalleryEntry',
              label: t('host.project.panel.gallery.newEntry'),
              icon: 'plus',
              onSelect: () =>
                openCreateGalleryEntryPrompt({
                  path: galleryMenu.gallery.path,
                  name: galleryMenu.gallery.name,
                  kind: 'directory'
                })
            },
            {
              id: 'editGalleryFields',
              label: t('host.project.panel.gallery.editFields'),
              icon: 'form',
              // 字段表就是那个图鉴目录里的 config.yml：打开它，表单那一档能改字段
              onSelect: () =>
                void openGalleryFile({
                  path: galleryMenu.gallery.configPath,
                  name: GALLERY_CONFIG_FILE_NAME
                })
            },
            {
              id: 'setCharacterGallery',
              label: t('host.project.panel.gallery.setCharacters'),
              icon: 'check',
              onSelect: () => void setCharacterGalleryAction(galleryMenu.gallery),
              /*
               * 已经是角色图鉴时置灰并说明原因：这一项点下去什么都不会变，而「点了一个
               * 没有反应的东西」比一个写着原因的灰项更让人怀疑自己点错了。
               */
              ...(isCharacterGallery(galleryMenu.gallery, registry)
                ? {
                    disabled: true,
                    disabledReason: t('host.project.panel.gallery.alreadyCharacters')
                  }
                : {})
            }
          ]}
        />
      )}

      {/* 列表里的每一行都是一个条目文件，所以共用块那一份菜单（重命名 / 删除）正好够用 */}
      {entryMenu && (
        <EntryMenu
          x={entryMenu.x}
          y={entryMenu.y}
          target={{ path: entryMenu.entry.path, name: entryMenu.entry.name, kind: 'file' }}
          onClose={() => setEntryMenu(null)}
        />
      )}
    </>
  )
}

/** 图鉴列表里被右键的那一项 */
interface GalleryMenu {
  gallery: GalleryFolder
  x: number
  y: number
}

/** 图鉴条目的右键位置 */
interface GalleryEntryMenu {
  entry: GalleryEntryFile
  x: number
  y: number
}

/**
 * 图鉴里的一行：显示条目的**名字**（第一个字段的值，取不到时是文件名）。
 *
 * 与章节列表里的行同一条约定：显示的是内容里真正写着的东西，完整路径留在 title 上。
 */
function GalleryEntryRow({
  entry,
  onContextMenu
}: {
  entry: GalleryEntryFile
  onContextMenu: (x: number, y: number) => void
}): JSX.Element {
  return (
    <button
      type="button"
      title={entry.path}
      onClick={() => void openGalleryFile(entry)}
      onContextMenu={(event) => {
        event.preventDefault()
        onContextMenu(event.clientX, event.clientY)
      }}
      className="flex w-full items-center gap-2 py-1 pr-1 pl-5 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800"
    >
      <BuiltinIcon name="file" className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
    </button>
  )
}

/**
 * 还没实现的分类。
 *
 * 泛型参数用 Exclude 把已经实现的那两项排除掉：多实现一项时，这里会因为类型不匹配
 * 而**编译不过** —— 「占位页还挂着」这件事因此不会靠记性来保证。
 */
function PlaceholderDisclosure({
  configKey
}: {
  configKey: Exclude<ProjectConfigKey, 'chapters' | 'foreshadowing' | 'gallery'>
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
