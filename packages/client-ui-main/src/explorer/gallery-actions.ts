import { getT } from '@nide/client-kit/stores/i18n.store'
import { useEditorStore } from '@nide/client-kit/stores/editor.store'
import { useExplorerStore } from '@nide/client-kit/stores/explorer.store'
import { characterGalleryOf, useGalleryStore } from '@nide/client-kit/stores/gallery.store'
import { loggerFor } from '@nide/client-kit/logger'
import {
  composeGalleryEntry,
  galleryEntryFileName,
  isGalleryConfigFileName,
  languageForPath,
  type GalleryFolder,
  type GalleryRegistry
} from '@nide/contracts/project'
import type { HostMessageKey } from '@nide/contracts/i18n'

const logger = loggerFor('gallery')

/**
 * 图鉴的三个动作：新建图鉴、新建条目、把某一个图鉴设成角色图鉴。
 *
 * 与 `chapter-actions.ts` 同一层、同一条约定：**写盘归主进程，这里只发起与刷新**。
 * 三个动作都会改盘（前两个写用户内容，后一个改 `.nide/config.yml` 里的角色图鉴），
 * 而落点由主进程核对（新建图鉴只允许建在配置里那个图鉴内容目录里，见 ipc/project.ipc.ts）。
 *
 * 与「文件树里右键新建」的差别，和章节那一层完全对称：**建出来那一刻是不是完整的**。
 * 树上的新建建的是一个空文件或空目录；这里是「开一个图鉴」与「开一个条目」，前者连
 * 字段表一起落盘，后者带着图鉴的骨架（`category: gallery` + 空的字段块）。
 */

/** 新建图鉴 / 条目的失败原因 -> 词条 key。两者共用一套：对用户来说都是「这个文件夹没建成」 */
function createFailureKey(reason: string): HostMessageKey {
  return `host.explorer.create.failed.${reason}` as HostMessageKey
}

/** 改注册表的失败原因 -> 词条 key */
const REGISTRY_FAILURE_KEYS: Record<
  'invalid-name' | 'unknown-gallery' | 'unreadable',
  HostMessageKey
> = {
  'invalid-name': 'host.project.panel.gallery.failed.invalid-name',
  'unknown-gallery': 'host.project.panel.gallery.failed.unknown-gallery',
  unreadable: 'host.project.panel.gallery.failed.unreadable'
}

/**
 * 新建一个图鉴：一个目录 + 它的默认字段表。
 *
 * 返回 null 表示成功（调用方据此关掉名字对话框），否则返回一句给用户看的话 —— 与
 * 树上的新建一致：失败时对话框留在原地让他改名字。
 *
 * 落点报的是**被打开对话框的那个目录**（图鉴内容目录）。它是不是配置里那一个由主进程
 * 核对，这里不判 —— 渲染进程声明不了「图鉴建到哪儿」。
 */
export async function createGalleryAction(
  target: { path: string },
  name: string
): Promise<string | null> {
  const result = await window.hostAPI.projects.createGallery({ targetPath: target.path, name })

  if (!result.ok) {
    logger.warn('Failed to create a gallery', { reason: result.reason })
    return getT()(createFailureKey(result.reason))
  }

  const explorer = useExplorerStore.getState()
  explorer.setNotice(null)

  /*
   * 两处缓存各刷一次：
   *
   * - 图鉴列表（这一层的数据来源）—— 强制重读，新图鉴要立刻出现；
   * - 文件树里那个目录（`target.path` 的那一层）—— 图鉴目录本来就在树上，不刷的话
   *   切到「文件」那一面看不到它。
   */
  await useGalleryStore.getState().load(target.path, true)
  await explorer.refreshDir(target.path)

  return null
}

/**
 * 在一个图鉴里新建条目：一个带骨架的 yml，建完**自动打开**它。
 *
 * 自动打开的理由与「新建章节」一样：这个动作就是「我要建这个角色 / 地点」，建完还让人
 * 去点一次是白费一次操作 —— 而条目建出来正是为了接着填字段。
 */
export async function createGalleryEntryAction(
  target: { path: string },
  name: string
): Promise<string | null> {
  const fileName = galleryEntryFileName(name)

  /**
   * `config.yml` 这个名字被**字段表**占着：它不会出现在条目列表里（见主进程的
   * readProjectGalleries），建出来只会得到一个「在树里看得见文件、在列表里看不见条目」
   * 的图鉴。与其让用户去猜，不如在这里说清楚。
   */
  if (isGalleryConfigFileName(fileName)) {
    return getT()('host.project.panel.gallery.failed.reserved-name')
  }

  const result = await window.hostAPI.projects.createEntry({
    kind: 'file',
    targetPath: target.path,
    name: fileName,
    // 内容与文件在同一次调用里落盘：分两次写会留一个「建好了但还不是图鉴」的中间态
    content: composeGalleryEntry()
  })

  if (!result.ok) {
    logger.warn('Failed to create a gallery entry', { reason: result.reason })
    return getT()(createFailureKey(result.reason))
  }

  const explorer = useExplorerStore.getState()
  const gallery = useGalleryStore.getState()
  explorer.setNotice(null)

  if (gallery.root !== null) await gallery.load(gallery.root, true)
  await explorer.refreshDir(target.path)

  await openGalleryFile({ path: result.path, name: fileName })
  return null
}

/**
 * 把一个图鉴设成角色图鉴（章节表单的出场角色从它里面选）。
 *
 * 这条动作**不写用户内容**，改的是 `.nide/config.yml` 里图鉴那一段的 `characters`，
 * 所以它没有对话框、也只会就地改一行：成功之后把主进程给回来的注册表记进 store
 * （重读整份图鉴列表只为了一行结果不合适）。失败进全局提示 —— 与删除失败同一个落点。
 */
export async function setCharacterGalleryAction(gallery: GalleryFolder): Promise<void> {
  const explorer = useExplorerStore.getState()

  try {
    const result = await window.hostAPI.projects.updateGalleryRegistry({
      characters: gallery.name
    })

    // null = 当前没有项目（这个窗口不该走到这里）：按读不了处理，提示里说的是同一件事
    if (!result || !result.ok) {
      const reason = result ? result.reason : 'unreadable'
      logger.warn('Failed to set the character gallery', { reason })
      explorer.setNotice(getT()(REGISTRY_FAILURE_KEYS[reason]))
      return
    }

    useGalleryStore.getState().setRegistry(result.registry)
    explorer.setNotice(null)
  } catch (err) {
    logger.error('Setting the character gallery failed unexpectedly', { error: err })
    explorer.setNotice(getT()(REGISTRY_FAILURE_KEYS.unreadable))
  }
}

/**
 * 打开一个图鉴条目或字段表（与文件树点一个条目走同一条路）。
 *
 * 不做「它是不是图鉴」的判断：那由文件自己回答（见 editor/document-mode.ts），而打开
 * 一个别的东西只是照常以纯文本出现。
 */
export async function openGalleryFile(file: { path: string; name: string }): Promise<void> {
  const explorer = useExplorerStore.getState()
  explorer.setNotice(null)

  try {
    const result = await window.hostAPI.projects.readFile(file.path)
    if (!result.ok) {
      logger.warn('Failed to open a gallery file', { name: file.name, reason: result.reason })
      explorer.setNotice(getT()(`host.explorer.open.failed.${result.reason}` as HostMessageKey))
      return
    }

    useEditorStore.getState().openFile({
      path: result.path,
      name: file.name,
      language: languageForPath(result.path),
      content: result.content
    })
  } catch (err) {
    logger.error('Opening a gallery file failed unexpectedly', { error: err })
  }
}

/** 这个图鉴是不是当前的角色图鉴（界面据此给它一个小标记，并把菜单项置灰） */
export function isCharacterGallery(
  gallery: GalleryFolder,
  registry: GalleryRegistry | null
): boolean {
  return characterGalleryOf([gallery], registry) !== null
}
