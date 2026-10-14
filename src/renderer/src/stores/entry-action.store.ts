import { create } from 'zustand'
import { getT } from './i18n.store'
import {
  createProjectEntry,
  deleteProjectEntry,
  renameProjectEntry,
  useExplorerStore
} from './explorer.store'
import { createScopeOf, type CreateScope, type EntryActionTarget } from '@renderer/entry/entry-menu'
import type { CreateEntryKind, DeleteEntryFailureReason } from '@shared/project'
import type { HostMessageKey } from '@shared/i18n'

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
  const result =
    request.mode === 'create'
      ? await createProjectEntry(request.kind, request.target.path, name)
      : await renameProjectEntry(request.target.path, name)

  if (!result.ok) {
    const action = request.mode === 'create' ? 'create' : 'rename'
    return getT()(`host.explorer.${action}.failed.${result.reason}` as HostMessageKey)
  }

  closePrompt()
  return null
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
