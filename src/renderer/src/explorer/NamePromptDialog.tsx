import { JSX, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '@renderer/stores/i18n.store'
import {
  extensionOf,
  validateEntryName,
  type CreateEntryKind,
  type FileTreeEntry,
  type InvalidNameReason
} from '@shared/project'
import type { HostMessageKey } from '@shared/i18n'

/**
 * 「新建文件 / 文件夹」与「重命名」的名字输入框。
 *
 * 画成渲染进程里的浮层（portal 到 body），理由与 ConfirmDialog 完全相同：宿主所有
 * 窗口都是无边框 + 自绘标题栏的，一个原生对话框会带着系统外观插进来；而且这个浮层
 * 的调用点在工具区里，`absolute` 会被那个区的 `overflow-hidden` 裁掉。
 *
 * **挂载点必须在右键菜单之外**（见 ExplorerView 的 PromptRequest）：`ContextMenu`
 * 在任何一个落在自己 DOM 之外的 `mousedown` 上关闭，而 portal 出去的内容按定义
 * 就在它之外 —— 挂在菜单下面时，点一下输入框就等于点了「菜单外面」。
 *
 * ## 校验在输入时做，不在提交时做
 *
 * 名字非法（空、含 `/`、以点开头……）是**纯逻辑**结论，不必等一次 IPC 往返。
 * 用 shared 的 validateEntryName 就地判，把原因写在输入框下面 —— 用户敲字的时候
 * 就知道哪儿不对，而不是点了按钮才被告知。
 *
 * 「这个名字已经有了」判不了（要读盘），那一条只能等主进程回答，由 onSubmit 的
 * 返回值带回来（见 ExplorerView）。
 *
 * ## 回车提交
 *
 * 输入框里回车就是确认，这是对话框的通用预期。焦点在输入框里，所以不需要全局
 * 键盘监听（Esc 除外，它必须能退出）。
 */

/** 名字非法原因 -> 词条 key */
const INVALID_NAME_KEYS: Record<InvalidNameReason, HostMessageKey> = {
  empty: 'host.explorer.name.error.empty',
  'path-separator': 'host.explorer.name.error.path-separator',
  'illegal-character': 'host.explorer.name.error.illegal-character',
  'leading-dot': 'host.explorer.name.error.leading-dot',
  'trailing-space-or-dot': 'host.explorer.name.error.trailing-space-or-dot',
  'too-long': 'host.explorer.name.error.too-long'
}

/** 新建的落点，只影响标题里那句「建在哪儿」 */
export type CreateScope = 'inside' | 'sibling'

export type NamePromptDialogProps = {
  /** 提交。返回 null 表示成功（浮层由调用方关掉），返回一句话表示失败 —— 那句话会
   * 显示在输入框下面，浮层**留在原地**让用户改名字。 */
  onSubmit: (name: string) => Promise<string | null>
  onCancel: () => void
} & (
  | {
      mode: 'create'
      kind: CreateEntryKind
      scope: CreateScope
      target: FileTreeEntry
    }
  | {
      mode: 'rename'
      target: FileTreeEntry
    }
)

export function NamePromptDialog(props: NamePromptDialogProps): JSX.Element {
  const { mode, target, onSubmit, onCancel } = props
  const t = useT()
  const titleId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  // 重命名时框里先放着它现在的名字：改一个字比重新敲一遍整名常见得多
  const [value, setValue] = useState(mode === 'rename' ? target.name : '')
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 开框就把焦点放进输入框，并**全选**：重命名时最顺手的动作是直接覆盖旧名字
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  const validation = validateEntryName(value)

  /**
   * 输入框里那个名字**去掉首尾空白之后**的样子。提交时用的就是它。
   *
   * 刻意不补默认扩展名（以前新建文件会补 `.md`）。补全之后磁盘上的名字与输入框里的
   * 就不是同一个了 —— 用户在框里看不到自己在改文件名；而「新建补、改名不补」这种
   * 不一致迟早要解释，不如两边都不补。代价是没有扩展名的文件在树里打不开（`not-text`），
   * 那是用户起的名字带来的结果，不是宿主背着他改的。
   */
  const trimmed = validation.ok ? validation.name : value.trim()
  /** 还没敲任何东西时不报错：空输入是初始状态，不是用户犯的错 */
  const inlineError =
    value.length > 0 && !validation.ok ? t(INVALID_NAME_KEYS[validation.reason]) : null
  const error = inlineError ?? failure

  const submit = async (): Promise<void> => {
    if (!validation.ok || busy) return

    setBusy(true)
    setFailure(null)
    try {
      const message = await onSubmit(validation.name)
      // 成功时调用方会把整个浮层卸掉，这里的 setState 落在一个已卸载的组件上也无妨
      if (message) setFailure(message)
    } finally {
      setBusy(false)
    }
  }

  const title =
    mode === 'rename'
      ? t('host.explorer.rename.title')
      : t(
          props.kind === 'file'
            ? (`host.explorer.newFile.${props.scope}` as HostMessageKey)
            : (`host.explorer.newFolder.${props.scope}` as HostMessageKey)
        )

  /**
   * 换了扩展名时多提醒一句。
   *
   * 改扩展名会改掉**宿主怎么对待这个文件**（能不能在编辑器里打开、用什么语法高亮），
   * 而「第一章.md → 第一章.txt」看起来只是改了几个字母。旧扩展名非空才提：
   * 从没有扩展名到有扩展名不是这里要管的事。
   */
  const previousExtension = mode === 'rename' ? extensionOf(target.name) : ''
  const extensionChanged =
    mode === 'rename' &&
    validation.ok &&
    previousExtension !== '' &&
    extensionOf(trimmed) !== previousExtension

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex w-[380px] max-w-[90%] flex-col gap-3 rounded-lg border border-zinc-700 bg-zinc-800 p-5 shadow-2xl shadow-black/50"
      >
        <h2 id={titleId} className="text-sm font-medium text-zinc-100">
          {title}
        </h2>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              // 改名字之后那条「已经有了」的提示就过期了
              setFailure(null)
            }}
            aria-invalid={error !== null}
            aria-describedby={error ? `${titleId}-error` : undefined}
            placeholder={t('host.explorer.name.placeholder')}
            className="w-full rounded border border-zinc-600 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-blue-500"
          />

          {extensionChanged && (
            <p className="mt-1.5 text-[11px] text-amber-400">
              {t('host.explorer.rename.extensionChanged', { name: trimmed })}
            </p>
          )}

          {error && (
            <p id={`${titleId}-error`} role="alert" className="mt-1.5 text-[11px] text-red-400">
              {error}
            </p>
          )}
        </form>

        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            // 未通过校验时禁用：这个动作没有二次确认，让一个必然失败的操作可点没意义
            disabled={!validation.ok || busy}
            onClick={() => void submit()}
            className="rounded bg-blue-600 px-3.5 py-1 text-xs text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
          >
            {t(mode === 'rename' ? 'host.explorer.rename.confirm' : 'host.explorer.name.confirm')}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded bg-zinc-700 px-3.5 py-1 text-xs text-zinc-100 transition-colors hover:bg-zinc-600"
          >
            {t('host.dialog.cancel')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
