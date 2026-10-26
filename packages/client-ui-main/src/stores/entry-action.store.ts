import { create } from 'zustand'
import { getT } from '@nide/client-kit/stores/i18n.store'
import {
  createProjectEntry,
  deleteProjectEntry,
  renameProjectEntry,
  useExplorerStore
} from '@nide/client-kit/stores/explorer.store'
import {
  createGalleryAction,
  createGalleryEntryAction
} from '@nide/client-ui-main/explorer/gallery-actions'
import { createOverviewDocumentAction } from '@nide/client-ui-main/explorer/overview-actions'
import {
  createScopeOf,
  type CreateScope,
  type EntryActionTarget
} from '@nide/client-ui-main/entry/entry-menu'
import type { CreateEntryKind, DeleteEntryFailureReason } from '@nide/contracts/project'
import type { HostMessageKey } from '@nide/contracts/i18n'

/**
 * 条目动作的**执行**与「正在问用户什么」。
 *
 * ## 为什么这一层必须提到视图之外
 *
 * 菜单项一律「先关菜单，再执行」（见 `ui/ContextMenu`），而名字对话框必须活得比菜单
 * 久 —— 它要是挂在菜单下面，`ContextMenu` 的「点别处就关」会把「点输入框」也算成外面，
 * 表现就是「点了新建没反应」。所以对话框不能由发起它的那个行/那个视图持有。
 *
 * 同理，删除的失败提示也不能留在某一个面板里：同一份菜单现在在文件树与章节列表两处
 * 出现，提示落在其中一处就会出现「用户没在看那个面板」。
 *
 * 状态与执行分开写在**同一个模块**里，与 explorer.store 同一条约定：
 * `useEntryActionStore` 只放「正在问什么」，下面那几个模块级函数才是动作本身。
 */

/**
 * 正在等用户输入名字的那一次动作。
 *
 * `key` 每次开框换一个：React 据此**重新挂载**对话框，否则「取消新建」之后紧接着
 * 「重命名」，输入框里会留着上一个人的文字。
 *
 * 几个「新建」的差别都在**建什么**：普通条目（文件 / 文件夹）、一个图鉴（目录 + 字段表）、
 * 一个图鉴条目（带骨架的 yml）、一份概述文档（普通 Markdown）。它们对用户是几个动作，
 * 所以各有一个自己的标题与确认逻辑（见 `submitPromptName`）。
 */
export type PendingPrompt =
  | {
      key: number
      mode: 'create'
      kind: CreateEntryKind
      target: EntryActionTarget
      scope: CreateScope
    }
  | { key: number; mode: 'rename'; target: EntryActionTarget }
  /** 新建一个图鉴：`target` 是图鉴内容目录 */
  | { key: number; mode: 'createGallery'; target: EntryActionTarget }
  /** 新建一个图鉴条目：`target` 是那个图鉴的目录 */
  | { key: number; mode: 'createGalleryEntry'; target: EntryActionTarget }
  /** 在概述目录里新建一份普通 Markdown：`target` 是概述内容目录 */
  | { key: number; mode: 'createOverviewDocument'; target: EntryActionTarget }

interface EntryActionState {
  /** 正在等用户输入名字的动作；null 表示没有对话框 */
  prompt: PendingPrompt | null
  setPrompt: (prompt: PendingPrompt | null) => void
}

export const useEntryActionStore = create<EntryActionState>((set) => ({
  prompt: null,
  setPrompt: (prompt) => set({ prompt })
}))

/** 对话框序号。模块级而不是组件里的 ref：开框的入口现在不止一个视图 */
let promptSeq = 0

/** 开「新建」的输入框。落点由目标决定（目录 -> 内部，文件 -> 同级） */
export function openCreatePrompt(kind: CreateEntryKind, target: EntryActionTarget): void {
  promptSeq += 1
  useEntryActionStore.getState().setPrompt({
    key: promptSeq,
    mode: 'create',
    kind,
    target,
    scope: createScopeOf(target)
  })
}

/** 开「重命名」的输入框，预填它现在的名字 */
export function openRenamePrompt(target: EntryActionTarget): void {
  promptSeq += 1
  useEntryActionStore.getState().setPrompt({ key: promptSeq, mode: 'rename', target })
}

/**
 * 开「新建图鉴」的输入框。落点固定是**图鉴内容目录**（`target` 就是它）。
 *
 * 与普通「新建文件夹」分开，是因为建出来的东西不一样：图鉴目录里必须有一份字段表
 * （见 shared/project/gallery），而那份表要和目录一起落盘。
 */
export function openCreateGalleryPrompt(target: EntryActionTarget): void {
  promptSeq += 1
  useEntryActionStore.getState().setPrompt({ key: promptSeq, mode: 'createGallery', target })
}

/**
 * 开「新建图鉴条目」的输入框，落点是某一个图鉴的目录。
 *
 * 名字没有扩展名时会补 `.yml`（见 NamePromptDialog 的 defaultExtension）：条目必须是
 * yml，而补出来的名字会显示在输入框下面，所以用户不会拿到一个他没看见过的文件名。
 */
export function openCreateGalleryEntryPrompt(target: EntryActionTarget): void {
  promptSeq += 1
  useEntryActionStore.getState().setPrompt({ key: promptSeq, mode: 'createGalleryEntry', target })
}

/**
 * 开「新建概述文档」的输入框，落点是**概述内容目录**。
 *
 * 名字没有扩展名时会补 `.md`（见 NamePromptDialog 的 defaultExtension）：概述面板只列
 * Markdown，而用户完全可以只敲「世界观」。补出来的名字会显示在输入框下面。
 *
 * 这份文档是普通文件，默认没有被标记成大纲 / 写作风格（要标记得另外右键）。
 */
export function openCreateOverviewDocumentPrompt(target: EntryActionTarget): void {
  promptSeq += 1
  useEntryActionStore
    .getState()
    .setPrompt({ key: promptSeq, mode: 'createOverviewDocument', target })
}

/** 关掉输入框（取消，或者提交成功之后） */
export function closePrompt(): void {
  useEntryActionStore.getState().setPrompt(null)
}

/**
 * 提交输入框里的名字。
 *
 * 返回 null 表示成功（浮层由 `EntryActionHost` 卸掉），返回一句话表示失败 —— 那句话
 * 显示在输入框下面，浮层**留在原地**让用户改名字：「这个名字已经有了」是可以就地修好的，
 * 关掉再让他重新右键一次是白费一次操作。
 *
 * 因此这里**不自己弹提示**，与 explorer.store 里那几个动作函数同一条约定。
 */
export async function submitPromptName(
  request: PendingPrompt,
  name: string
): Promise<string | null> {
  let message: string | null

  /*
   * 每个「新建」走自己的动作：普通条目写一个空文件 / 空目录，图鉴连字段表一起写，
   * 条目写一份骨架，概述文档写一个空 Markdown。它们的失败文案共用一套（都是
   * 「没建成」），差别只在建的是什么。
   */
  switch (request.mode) {
    case 'create':
      message = await submitCreate(request, name)
      break
    case 'createGallery':
      message = await createGalleryAction(request.target, name)
      break
    case 'createGalleryEntry':
      message = await createGalleryEntryAction(request.target, name)
      break
    case 'createOverviewDocument':
      message = await createOverviewDocumentAction(request.target, name)
      break
    case 'rename':
      message = await submitRename(request.target.path, name)
      break
  }

  if (message !== null) return message

  closePrompt()
  return null
}

/** 新建一个普通条目（文件 / 文件夹） */
async function submitCreate(
  request: Extract<PendingPrompt, { mode: 'create' }>,
  name: string
): Promise<string | null> {
  const result = await createProjectEntry(request.kind, request.target.path, name)
  if (result.ok) return null

  return getT()(`host.explorer.create.failed.${result.reason}` as HostMessageKey)
}

/** 重命名一个条目。与新建分开：两者失败时说的话不一样（「建不了」/「改不了」） */
async function submitRename(targetPath: string, name: string): Promise<string | null> {
  const result = await renameProjectEntry(targetPath, name)
  if (result.ok) return null

  return getT()(`host.explorer.rename.failed.${result.reason}` as HostMessageKey)
}

/**
 * 删除失败原因 -> 词条 key。
 *
 * 删除没有对话框可以「留在原地」，所以这些文案进的是全局提示（见 EntryActionHost）。
 *
 * `cancelled` 刻意**不在表里**：那是用户在确认框里按了「取消」，什么都没发生，
 * 不该冒出一句提示。类型上用 Exclude 把这条排除掉，查表之前必须先把它挡掉 ——
 * 「取消不算失败」这条规则因此是编译期可见的，而不是靠注释约定。
 */
const DELETE_FAILURE_KEYS: Record<
  Exclude<DeleteEntryFailureReason, 'cancelled'>,
  HostMessageKey
> = {
  'not-empty': 'host.explorer.delete.failed.not-empty',
  'not-a-file': 'host.explorer.delete.failed.not-a-file',
  'is-project-root': 'host.explorer.delete.failed.is-project-root',
  unreadable: 'host.explorer.delete.failed.unreadable'
}

/**
 * 删除一个条目。
 *
 * **二次确认不在这里**：它问在主进程的动作出口上（见 main/confirm.ts），无论从哪个
 * 视图、哪一份菜单发起都会经过那一问。这里只负责把结果反映出来。
 *
 * 失败写进 explorer store 的 `notice`（由 `EntryActionHost` 画成全局提示）。菜单现在
 * 在文件树与章节列表两处出现，而提示只有一个落点 —— 写进某一个面板里就会出现「用户
 * 没在看那个面板」。
 */
export async function requestDelete(target: EntryActionTarget): Promise<void> {
  const result = await deleteProjectEntry(target.path)
  if (result.ok || result.reason === 'cancelled') return

  useExplorerStore.getState().setNotice(getT()(DELETE_FAILURE_KEYS[result.reason]))
}
