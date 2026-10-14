import { getT } from '@renderer/stores/i18n.store'
import { useEditorStore } from '@renderer/stores/editor.store'
import { useExplorerStore } from '@renderer/stores/explorer.store'
import { loggerFor } from '@renderer/logger'
import {
  composeChapterDocument,
  defaultChapterFileName,
  nextChapterNumber,
  takenChapterFileNumbers,
  usedChapterNumbers,
  type CreateEntryResult
} from '@shared/project'
import type { HostMessageKey } from '@shared/i18n'

const logger = loggerFor('explorer')

/**
 * 新建一章。
 *
 * 与「文件树里右键新建文件」是两个动作，差别全在**文件建出来那一刻是不是完整的**：
 *
 * - 树上的新建是「先占个位置」：名字由用户起，内容为空；
 * - 这里是「开一章新稿」：文件名有一个默认值（`chapter_1.md`，可改），而开头必须
 *   带上章节属性（frontmatter 里的章节号，见 shared/project/chapters）。
 *
 * 所以内容是**和文件一起**落盘的（走 createEntry 的 content 参数，不是建完再写一次）：
 * 分两次写会在磁盘上留一个「建好了但还没有编号」的中间态，而那个中间态恰好是一篇
 * 看起来正常、其实没有章节号的稿子。
 *
 * 编号取「已用章节号的最大值 + 1」，并且躲开目录里已经存在的默认文件名（用户可能
 * 删掉了某一章的 frontmatter，而 `chapter_003.md` 还在）。
 */

/**
 * 下一个可以用的章节号，以及它的默认文件名。
 *
 * 章节目录还没有定下来时返回 null（配置读失败、内容目录不存在）：调用方据此禁用
 * 入口 —— 让用户先敲一个名字、再告诉他「不知道建到哪儿」，是白费一次输入。
 */
export function suggestNextChapter(): { chapter: number; fileName: string } | null {
  const { chaptersDir, chapters } = useExplorerStore.getState()
  if (!chaptersDir) return null

  const known = chapters ?? []
  const chapter = nextChapterNumber(usedChapterNumbers(known), takenChapterFileNumbers(known))

  return { chapter, fileName: defaultChapterFileName(chapter) }
}

/**
 * 建一章：在章节目录下建一个 Markdown 文件，开头带上章节属性。
 *
 * 返回 null 表示成功（调用方据此关掉对话框），否则返回一句给用户看的话 —— 与
 * 「文件树里新建」那条路一致：失败时对话框留在原地让他改名字。
 *
 * 落点报的是**目录自己**：createEntry 的目标目录由被点的条目推导（目录 -> 内部），
 * 而这里要建的正是「这个目录里的一份新文件」。
 */
export async function createChapter(chapter: number, fileName: string): Promise<string | null> {
  const store = useExplorerStore.getState()
  const dir = store.chaptersDir

  if (!dir) {
    logger.warn('Refused to create a chapter without a content directory')
    return getT()('host.project.panel.chapter.no-dir')
  }

  store.setNotice(null)

  /**
   * 名字的扩展名由用户决定（可能是空的），**不补** `.md`：与树上新建同一条约定 ——
   * 用户敲什么名字，磁盘上就是什么名字。代价是没有扩展名的文件在树里点不开，那是
   * 他自己起的名字带来的结果。
   */
  const result: CreateEntryResult = await window.hostAPI.projects.createEntry({
    kind: 'file',
    targetPath: dir,
    name: fileName,
    content: composeChapterDocument(chapter)
  })

  if (!result.ok) {
    logger.warn('Failed to create a chapter', { reason: result.reason })
    return getT()(`host.project.panel.chapter.failed.${result.reason}` as HostMessageKey)
  }

  // 新章节同时在两处出现（项目标签页的列表、文件树），而它们各自有一份缓存
  await store.loadChapters()
  await store.refreshDir(dir)

  /**
   * 新章**自动打开**。与树上新建的立场不同：这里的动作就是「我要开始写这一章」，
   * 建完还让人再去点一次是白费一次操作；而树上新建常常只是先占个位置。
   */
  await openChapter(result.path, fileName)

  return null
}

/** 打开一章，并把树展开到它 */
async function openChapter(path: string, name: string): Promise<void> {
  try {
    const content = await window.hostAPI.projects.readFile(path)
    if (!content.ok) {
      logger.warn('Failed to read a freshly created chapter', { reason: content.reason })
      return
    }

    useEditorStore.getState().openFile({
      path: content.path,
      name,
      language: 'markdown',
      content: content.content
    })

    // 章节目录通常已经开着，这一步多半只是把链上的目录展开
    await useExplorerStore.getState().reveal(content.path)
  } catch (err) {
    logger.error('Opening a freshly created chapter failed unexpectedly', { error: err })
  }
}

/** 打开章节列表里的一个文件（与文件树点条目同一条路） */
export async function openChapterFile(file: { path: string; name: string }): Promise<void> {
  const store = useExplorerStore.getState()
  store.setNotice(null)

  try {
    const result = await window.hostAPI.projects.readFile(file.path)
    if (!result.ok) {
      logger.warn('Failed to open a chapter file', { name: file.name, reason: result.reason })
      store.setNotice(getT()(`host.explorer.open.failed.${result.reason}` as HostMessageKey))
      return
    }

    useEditorStore.getState().openFile({
      path: result.path,
      name: file.name,
      language: 'markdown',
      content: result.content
    })
  } catch (err) {
    logger.error('Opening a chapter file failed unexpectedly', { error: err })
  }
}
