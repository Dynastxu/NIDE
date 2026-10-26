import { getT } from '@nide/client-kit/stores/i18n.store'
import { useEditorStore } from '@nide/client-kit/stores/editor.store'
import { useExplorerStore } from '@nide/client-kit/stores/explorer.store'
import { useOverviewStore } from '@nide/client-kit/stores/overview.store'
import { loggerFor } from '@nide/client-kit/logger'
import {
  OVERVIEW_ROLES,
  extensionOf,
  isMarkdownPath,
  languageForPath,
  type CreateEntryResult,
  type OverviewDocument,
  type OverviewRole,
  type ProjectConfig
} from '@shared/project'
import type { HostMessageKey } from '@shared/i18n'

const logger = loggerFor('overview')

/**
 * 概述的动作：新建普通 Markdown、把某份 Markdown 标记成大纲 / 写作风格。
 *
 * 与 gallery-actions 同一层、同一条约定：**写盘归主进程，这里只发起与刷新**。
 *
 * 概述里的文件全是普通 Markdown；「大纲 / 写作风格」只是两个标记，记在
 * `.nide/config.yml` 的概述段里（见 shared/project/overview）。所以这里没有
 * 「新建预设」—— 用户新建的就是一份普通文档，然后按需给它打标记。
 */

/** 新建文档的失败原因 -> 词条 key */
function createFailureKey(reason: string): HostMessageKey {
  return `host.project.panel.overview.failed.${reason}` as HostMessageKey
}

/** 改标记的失败原因 -> 词条 key */
const ROLE_FAILURE_KEYS: Record<'invalid-name' | 'unknown-file' | 'unreadable', HostMessageKey> = {
  'invalid-name': 'host.project.panel.overview.role.failed.invalid-name',
  'unknown-file': 'host.project.panel.overview.role.failed.unknown-file',
  unreadable: 'host.project.panel.overview.role.failed.unreadable'
}

/** 重读概述列表（配置结论优先：它才是当前项目的概述目录） */
async function reloadOverviewList(): Promise<void> {
  const root = useExplorerStore.getState().overviewDir ?? useOverviewStore.getState().root
  if (root) await useOverviewStore.getState().load(root, true)
}

/** 配置里某个角色的文件名；没有标记时给 null */
export function overviewRoleName(config: ProjectConfig | null, role: OverviewRole): string | null {
  if (!config) return null

  const name = role === 'outline' ? config.overview.outline : config.overview.style
  return typeof name === 'string' ? name : null
}

/**
 * 这份文档被标记成了哪个角色；没有标记时给 null。
 *
 * 大小写折叠着比：大小写不敏感的文件系统上，配置写 `outline.md`、磁盘上是
 * `Outline.md` 时它们仍是同一个文件。界面上只用来显示一个小标记，认错一个大小写
 * 比让标记凭空消失更糟。
 */
export function roleOfDocument(
  config: ProjectConfig | null,
  file: OverviewDocument
): OverviewRole | null {
  for (const role of OVERVIEW_ROLES) {
    const name = overviewRoleName(config, role)
    if (name !== null && name.toLowerCase() === file.name.toLowerCase()) return role
  }

  return null
}

/** 这个文件是不是当前的大纲 / 写作风格。界面据此置灰「标记为……」那一项 */
export function isRoleDocument(
  config: ProjectConfig | null,
  role: OverviewRole,
  file: OverviewDocument
): boolean {
  const name = overviewRoleName(config, role)
  return name !== null && name.toLowerCase() === file.name.toLowerCase()
}

/** 没有扩展名时补 `.md`。有扩展名时按原样交给调用方判（见下） */
function withMarkdownExtension(name: string): string {
  return extensionOf(name).length === 0 ? `${name}.md` : name
}

/**
 * 在概述目录里新建一篇普通 Markdown 文档。
 *
 * 概述面板只列 Markdown，所以这里**拒绝非 Markdown 的扩展名**（`.txt`、`.yml`）：
 * 建出来之后它不会出现在这个面板里，用户会以为没建成。没有扩展名时补 `.md`，并把
 * 补出来的名字显示在输入框下面（见 NamePromptDialog 的 defaultExtension）。
 *
 * 新文档**不带标记**：要当大纲 / 写作风格得另外右键标记（标记是独立的动作）。
 */
export async function createOverviewDocumentAction(
  target: { path: string },
  name: string
): Promise<string | null> {
  const fileName = withMarkdownExtension(name)

  if (!isMarkdownPath(fileName)) {
    return getT()('host.project.panel.overview.failed.not-markdown')
  }

  const result: CreateEntryResult = await window.hostAPI.projects.createEntry({
    kind: 'file',
    targetPath: target.path,
    name: fileName,
    // 内容与文件在同一次调用里落盘：分两次写会留一个「建好了但还没有内容」的中间态
    content: ''
  })

  if (!result.ok) {
    logger.warn('Failed to create an overview document', { reason: result.reason })
    return getT()(createFailureKey(result.reason))
  }

  const explorer = useExplorerStore.getState()
  explorer.setNotice(null)

  await reloadOverviewList()
  await explorer.refreshDir(target.path)

  await openOverviewFile({ path: result.path, name: fileName })
  return null
}

/**
 * 把某份 Markdown 标记成大纲 / 写作风格。
 *
 * 这条动作**不写文件本身**，改的是项目配置的概述那一段：成功之后把主进程给回来的
 * 配置记进 explorer store（标记就在那里）。失败进全局提示 —— 与删除失败同一个落点。
 */
export async function setOverviewRoleAction(
  role: OverviewRole,
  file: OverviewDocument
): Promise<void> {
  const explorer = useExplorerStore.getState()

  try {
    const result = await window.hostAPI.projects.setOverviewRole({
      role,
      fileName: file.name
    })

    if (!result.ok) {
      logger.warn('Failed to mark an overview document', { reason: result.reason })
      explorer.setNotice(getT()(ROLE_FAILURE_KEYS[result.reason]))
      return
    }

    explorer.setConfig(result.config)
    explorer.setNotice(null)
  } catch (err) {
    logger.error('Marking an overview document failed unexpectedly', { error: err })
    explorer.setNotice(getT()(ROLE_FAILURE_KEYS.unreadable))
  }
}

/**
 * 打开概述里的一个文件（与文件树点一个条目走同一条路）。
 *
 * 不做「它是不是大纲」的判断：大纲与写作风格只是普通 Markdown 上的标记；打开它就是
 * 打开一份文档。
 */
export async function openOverviewFile(file: { path: string; name: string }): Promise<void> {
  const explorer = useExplorerStore.getState()
  explorer.setNotice(null)

  try {
    const result = await window.hostAPI.projects.readFile(file.path)
    if (!result.ok) {
      logger.warn('Failed to open an overview file', { name: file.name, reason: result.reason })
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
    logger.error('Opening an overview file failed unexpectedly', { error: err })
  }
}
