import { getT } from '@nide/client-kit/stores/i18n.store'
import { useEditorStore } from '@nide/client-kit/stores/editor.store'
import { useExplorerStore } from '@nide/client-kit/stores/explorer.store'
import { loggerFor } from '@nide/client-kit/logger'
import {
  composeForeshadowingEntry,
  DEFAULT_FORESHADOWING_EXTENSION,
  type CreateEntryResult
} from '@shared/project'
import type { HostMessageKey } from '@shared/i18n'

const logger = loggerFor('explorer')

/** 默认文件名的前缀：`foreshadowing_1.yml`。序号只影响名字，与伏笔的内容无关 */
const DEFAULT_FILE_PREFIX = 'foreshadowing_'

/**
 * 新建一条伏笔。
 *
 * 与「文件树里右键新建文件」是两个动作，差别全在**文件建出来那一刻是不是完整的**：
 *
 * - 树上的新建是「先占个位置」：名字由用户起，内容为空；
 * - 这里是「记一条新伏笔」：文件名有一个可改的默认值，而整份文件必须带类别与数据块
 *   （见 shared/project/foreshadowing 的 composeForeshadowingEntry）。
 *
 * 内容是**和文件一起**落盘的（走 createEntry 的 content 参数，不是建完再写一次）：
 * 分两次写会在磁盘上留一个「建好了但还不是伏笔」的中间态，而那个中间态打不开表单。
 */

/**
 * 下一个可以用的默认文件名。
 *
 * 目录还没有定下来时返回 null（配置读失败、内容目录不存在）：调用方据此禁用入口 ——
 * 让用户先敲一个名字、再告诉他「不知道建到哪儿」，是白费一次输入。
 *
 * 序号取「已有默认文件名的最大值 + 1」：删掉中间某一条之后，新建的那条仍然不会撞上
 * 正被占用的名字。用户自己起的名字不参与这个计算，它是不是一条伏笔由文件内容决定。
 */
export function suggestNextForeshadowing(): { fileName: string } | null {
  const { foreshadowingDir, foreshadowing } = useExplorerStore.getState()
  if (!foreshadowingDir) return null

  let highest = 0

  for (const file of foreshadowing ?? []) {
    const match = /^foreshadowing_(\d+)\.ya?ml$/i.exec(file.name)
    if (!match) continue

    const value = Number(match[1])
    if (Number.isSafeInteger(value) && value > highest) highest = value
  }

  return { fileName: `${DEFAULT_FILE_PREFIX}${highest + 1}${DEFAULT_FORESHADOWING_EXTENSION}` }
}

/**
 * 建一条伏笔：在伏笔目录下建一个 yml 文件，整份文件带类别与空的数据块。
 *
 * 返回 null 表示成功（调用方据此关掉对话框），否则返回一句给用户看的话 —— 与
 * 「文件树里新建」那条路一致：失败时对话框留在原地让他改名字。
 *
 * 落点报的是**目录自己**：createEntry 的目标目录由被点的条目推导（目录 -> 内部），
 * 而这里要建的正是「这个目录里的一份新文件」。
 */
export async function createForeshadowing(fileName: string): Promise<string | null> {
  const store = useExplorerStore.getState()
  const dir = store.foreshadowingDir

  if (!dir) {
    logger.warn('Refused to create a foreshadowing without a content directory')
    return getT()('host.project.panel.foreshadowing.no-dir')
  }

  store.setNotice(null)

  /**
   * 名字的扩展名由对话框补：没写扩展名时补 `.yml`（伏笔必须是 yml，见 NamePromptDialog
   * 的 defaultExtension）；写了 `.yaml` 就按用户写的那个落盘。
   */
  const result: CreateEntryResult = await window.hostAPI.projects.createEntry({
    kind: 'file',
    targetPath: dir,
    name: fileName,
    content: composeForeshadowingEntry()
  })

  if (!result.ok) {
    logger.warn('Failed to create a foreshadowing', { reason: result.reason })
    return getT()(`host.project.panel.foreshadowing.failed.${result.reason}` as HostMessageKey)
  }

  // 新伏笔同时在两处出现（项目标签页的列表、文件树），而它们各自有一份缓存
  await store.loadForeshadowing()
  await store.refreshDir(dir)

  /**
   * 新伏笔**自动打开**：动作的意思就是「我要记下这一条」，建完还让人再去点一次是
   * 白费一次操作；而树上新建常常只是先占个位置。
   */
  await openForeshadowing(result.path, fileName)

  return null
}

/** 打开一条伏笔，并把树展开到它 */
async function openForeshadowing(path: string, name: string): Promise<void> {
  try {
    const content = await window.hostAPI.projects.readFile(path)
    if (!content.ok) {
      logger.warn('Failed to read a freshly created foreshadowing', { reason: content.reason })
      return
    }

    useEditorStore.getState().openFile({
      path: content.path,
      name,
      language: 'yaml',
      content: content.content
    })

    // 伏笔目录通常已经开着，这一步多半只是把链上的目录展开
    await useExplorerStore.getState().reveal(content.path)
  } catch (err) {
    logger.error('Opening a freshly created foreshadowing failed unexpectedly', { error: err })
  }
}

/** 打开伏笔列表里的一个文件（与文件树点条目同一条路） */
export async function openForeshadowingFile(file: { path: string; name: string }): Promise<void> {
  const store = useExplorerStore.getState()
  store.setNotice(null)

  try {
    const result = await window.hostAPI.projects.readFile(file.path)
    if (!result.ok) {
      logger.warn('Failed to open a foreshadowing file', { name: file.name, reason: result.reason })
      store.setNotice(getT()(`host.explorer.open.failed.${result.reason}` as HostMessageKey))
      return
    }

    useEditorStore.getState().openFile({
      path: result.path,
      name: file.name,
      language: 'yaml',
      content: result.content
    })
  } catch (err) {
    logger.error('Opening a foreshadowing file failed unexpectedly', { error: err })
  }
}
