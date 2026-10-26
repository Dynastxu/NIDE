import { loggerFor } from '@nide/client-kit/logger'
import { useEditorStore } from '@nide/client-kit/stores/editor.store'
import { useExplorerStore } from '@nide/client-kit/stores/explorer.store'
import { modelFor } from '@nide/client-ui-main/editor/model-registry'
import {
  isGalleryConfigFileName,
  isGalleryEntryDocument,
  isGalleryEntryPath,
  readGalleryEntry
} from '@shared/project'
import type { FileWriteResult } from '@shared/project'

const logger = loggerFor('editor')

/**
 * 保存：把编辑器里的正文写回它来自的那个文件。
 *
 * ## 正文从哪儿来
 *
 * 从 **model** 里来，不从 store 里来 —— store 里只有「与磁盘一致的那一份」和一个
 * dirty 结论，正文本身只有一份，就在 model 里（见 stores/editor.store 的说明）。
 * 所以这里是「读 model -> 走一条 IPC -> 把基准推到刚写下去的那一份」。
 *
 * ## 谁赢
 *
 * 用户按下保存，就是「以我手里这份为准」。宿主不去比较时间戳、也不留副本：那两件事
 * 都需要先定下谁权威、副本放哪儿、留几份，而这一层做不了那个决定。它只负责把该拒的
 * 交给主进程拒掉（目标没了、跑出项目、是个链接），并把结果如实回报给界面。
 *
 * ## 保存与「关标签页那一问」共用这一个函数
 *
 * 标签条上的圆点问出来的「保存吗」，按「保存」走的正是这里 —— 四条入口（`Ctrl+S`、
 * 标题栏文件菜单、标签条「更多」、关闭时那一问）因此不可能对「保存到底是什么」有
 * 两套理解。
 *
 * ## 保存之后只有一件事是「顺带」做的
 *
 * 图鉴的文件（条目 / 字段表）存下去之后，图鉴列表那一份缓存要重读一次：列表里的名字
 * 与条目表单的字段都来自它，而它是按「一次会话读一次」缓存的（见下面那条说明）。
 * 除此之外没有任何副作用 —— 写完盘之后，谁赢、要不要留副本，仍然没有第二套规则。
 */

/**
 * 保存一个标签页。
 *
 * 返回 `{ ok: true }` 时磁盘上的内容就是调用那一刻 model 里的那一份。失败按原因回报，
 * **不抛异常**：界面（保存对话框）要据原因说一句话，而不是接一个 rejected promise。
 */
export async function saveTab(path: string): Promise<FileWriteResult> {
  const model = modelFor(path)

  /**
   * 没有 model 就去查标签页：这一句挡的是「标签页已经关了，而保存还在路上」那种竞态，
   * 以及调用方拼错路径。给一个准确的原因，而不是抛。
   */
  if (!model) {
    logger.warn('Refused to save a file that has no editor model', { file: path })
    return { ok: false, reason: 'not-a-file' }
  }

  /**
   * 先把正文取下来（**不是**写完再取）。
   *
   * 写盘是异步的，这中间用户可以继续打字 —— 那时 model 里的内容已经比刚写下去的
   * 那一份新了。基准要按**写下去的那一份**推进，多出来的改动留给下面第二步重新标脏。
   */
  const content = model.getValue()

  try {
    const result = await window.hostAPI.projects.writeFile({ filePath: path, content })
    if (!result.ok) {
      logger.warn('Failed to save a file', { file: path, reason: result.reason })
      return result
    }

    const store = useEditorStore.getState()

    /**
     * 磁盘上现在就是这一份内容 —— 把它记成这个标签页的新基准（清掉圆点）。
     *
     * 走 syncFromDisk 而不是自己改 store：那句话描述的事实（「磁盘上是什么」）在这里
     * 完全成立，而多一条只差一个字的动作，迟早会和这一条各自演化。
     */
    store.syncFromDisk(path, content)

    /**
     * 写入期间用户又敲了字：model 里那份比磁盘上的新，标签必须继续是脏的。
     *
     * setDocument 重算的正是「与基准是否一致」，所以这里只是把结论再算一次 —— 少了
     * 这一步，圆点会在保存之后灭掉，而正文与磁盘其实并不一致。
     */
    const latest = model.getValue()
    if (latest !== content) store.setDocument(path, latest)

    /**
     * 保存的是一份**图鉴的文件**时（条目或字段表），把图鉴列表那一份缓存也刷一次。
     *
     * 「项目 -> 图鉴」里每一行显示的名字取自条目的第一个字段，而那一份是按「一次会话
     * 读一次」缓存着的（见 gallery.store）：刚把 `名称` 填上、存下来之后不刷新，列表里
     * 那一行还是旧名字 —— 用户会以为自己的改动没生效。字段表同理：条目表单的字段来自它。
     *
     * 刷在**保存**这一处而不是表单的每次输入上：后者是一次按键一条 IPC，而保存本来就是
     * 用户显式说「就以这一份为准」的那一下。
     */
    const galleryFile =
      isGalleryConfigFileName(path) ||
      (isGalleryEntryPath(path) && isGalleryEntryDocument(readGalleryEntry(content)))

    if (galleryFile) void useExplorerStore.getState().loadGalleries(true)

    logger.info('File saved', { file: path })
    return { ok: true, path }
  } catch (err) {
    // 主进程的 handle 不该抛，但真抛了也不能让保存对话框停在一个没有回音的状态
    logger.error('Saving a file failed unexpectedly', { file: path, error: err })
    return { ok: false, reason: 'unreadable' }
  }
}

/**
 * 保存当前标签页。
 *
 * 返回 null 表示**什么都没做**，有两种情形，都不该给用户任何提示：
 *
 * - 一个文件都没打开（没有当前标签页）；
 * - 当前这一个没有未落盘的改动 —— 写下去的就是磁盘上已有的那一份，而一次写入会换掉
 *   文件的 inode 与 mtime（见主进程的原子替换）。一个键位按下去没有任何可观察的变化，
 *   比「按了有时有反应、有时没有」诚实。
 */
export async function saveActiveTab(): Promise<FileWriteResult | null> {
  const { tabs, activePath } = useEditorStore.getState()
  const tab = tabs.find((item) => item.path === activePath)

  if (!tab || !tab.dirty) return null
  return saveTab(tab.path)
}
