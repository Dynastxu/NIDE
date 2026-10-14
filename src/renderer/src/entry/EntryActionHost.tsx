import { JSX } from 'react'
import { BuiltinIcon } from '@renderer/ui/BuiltinIcon'
import { useT } from '@renderer/stores/i18n.store'
import { useExplorerStore } from '@renderer/stores/explorer.store'
import {
  closePrompt,
  submitPromptName,
  useEntryActionStore
} from '@renderer/stores/entry-action.store'
import { NamePromptDialog } from '@renderer/entry/NamePromptDialog'

/**
 * 条目动作在界面上的两个落点：名字输入框与失败提示。
 *
 * **挂在窗口顶层，而不是由发起动作的那个视图持有** —— 与 `ui/ConfirmHost` 同一条
 * 理由：动作的发起点在视图里，而它要问的东西必须活得比那个视图的局部状态久。
 * 它只挂在主窗口（见 MainApp）：条目动作只在那里存在，这一点与 ConfirmHost
 * 「每种窗口都要有地方接住」不同。
 *
 * 1. **输入框**：菜单一点就关（见 `ui/ContextMenu`），新建 / 重命名却要接着问一个名字。
 *    由视图持有的那次实现里，菜单的「点别处就关」把「点输入框」也算成了外面 ——
 *    一碰输入框整个对话框就被连根卸掉。现在它挂在窗口顶层，与菜单没有任何父子关系。
 *
 * 2. **提示**：删除是不可撤销的动作，它的失败必须**无论从哪个视图发起都看得见**。
 *    同一份菜单现在出现在文件树与章节列表两处，提示留在其中任何一个面板里，都会有
 *    「用户没在看那个面板」的时候。所以它画成一条全局浮层，落在窗口底部。
 *
 * 提示的文案与生命周期不在这里：谁写进 explorer store 的 notice，谁就负责在成功时
 * 清掉它（见 explorer.store 的文件操作与 entry-action.store 的 requestDelete）。
 */
export function EntryActionHost(): JSX.Element {
  const prompt = useEntryActionStore((s) => s.prompt)

  return (
    <>
      {/*
        key 绑编号：换一次动作就重新挂载，输入框的初值、焦点与 Esc 监听都跟着重来一遍 ——
        否则「取消新建」之后紧接着「重命名」，框里会留着上一个人的文字。
      */}
      {prompt &&
        (prompt.mode === 'create' ? (
          <NamePromptDialog
            key={prompt.key}
            mode="create"
            kind={prompt.kind}
            scope={prompt.scope}
            target={prompt.target}
            onCancel={closePrompt}
            onSubmit={(name) => submitPromptName(prompt, name)}
          />
        ) : (
          <NamePromptDialog
            key={prompt.key}
            mode="rename"
            target={prompt.target}
            onCancel={closePrompt}
            onSubmit={(name) => submitPromptName(prompt, name)}
          />
        ))}

      <NoticeToast />
    </>
  )
}

/**
 * 条目动作失败时的那一条提示。
 *
 * 不做自动消失：它说的是「你刚做的那件事没成」，读不读得完由用户决定。下一次成功的
 * 文件操作会把它清掉（见 explorer.store），用户也可以自己关掉。
 */
function NoticeToast(): JSX.Element | null {
  const t = useT()
  const notice = useExplorerStore((s) => s.notice)
  const setNotice = useExplorerStore((s) => s.setNotice)

  if (!notice) return null

  return (
    <div
      role="alert"
      className="fixed bottom-4 left-1/2 z-[90] flex w-max max-w-[min(560px,80vw)] -translate-x-1/2 items-start gap-2 rounded-md border border-amber-900/60 bg-amber-950/95 px-3 py-2 shadow-xl shadow-black/40"
    >
      <p className="min-w-0 flex-1 text-[11px] leading-4 text-amber-200">{notice}</p>
      <button
        type="button"
        aria-label={t('host.editor.tab.close')}
        onClick={() => setNotice(null)}
        className="shrink-0 rounded p-0.5 text-amber-300 hover:bg-amber-900/50"
      >
        <BuiltinIcon name="close" className="h-3 w-3" />
      </button>
    </div>
  )
}
