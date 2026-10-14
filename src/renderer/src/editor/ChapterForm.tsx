import { JSX, useEffect, useRef, useState, type ReactNode } from 'react'
import { formatChapterNumber, type ChapterMetadata } from '@shared/project'
import { useT } from '@renderer/stores/i18n.store'

/**
 * 章节表单：把 frontmatter 里的那几项元数据摆成一组字段。
 *
 * ## 从上到下
 *
 * ```
 * 索引         ［输入框］
 * 细纲         ［多行文本］
 * 出场角色      ［只读列表］      ← 要从图鉴里选，图鉴还没实现
 * 备注         ［多行文本］
 * 概述         ［多行文本］
 * ```
 *
 * 它是**一组纯字段**：由调用方摆进主视图（见 EditorPanes 表单那一格），高度按内容排 ——
 * 这一格里有高度的是下面那个正文编辑器，它由调用方负责。
 *
 * ## 字段的本地草稿
 *
 * 输入框里的字与 store 里那份元数据**不是**同一个东西：用户正在打字时 `1`、`10` 都还不是
 * 一个合法的索引。所以这一层持有一份草稿，只在能解释成一个值时往上送（见 commit）。
 *
 * 草稿是**挂载时**从元数据取的（`useState` 的初值），此后的每次输入只改草稿 ——
 * 于是「用户正在敲的那个字符串」不会被上游的重渲染冲掉。上游在别处被改过时（用户在
 * 纯文本视图里改了 frontmatter）由调用方换掉 `key` 重新挂载这一层（见 EditorPanes），
 * 草稿因此重新取自最新的那一份。用 key 而不是在 effect 里同步 state：后者会先渲染
 * 一帧旧值再渲染一帧新值，用户看得见字段闪一下。
 *
 * ## 出场角色为什么不能编辑
 *
 * 它要从图鉴里选（`gallery` 那一类内容），而图鉴还没实现（见 ProjectsPanel 里另外
 * 三个分类的占位）。先把它**只读地显示出来**：这一项已经在元数据里、也能被宿主读，
 * 藏起来只会让人以为文件里的那几行是多余的。
 */

/** 表单里各字段的草稿。与 ChapterMetadata 的差别只有索引：这里是用户正在敲的那个字符串 */
interface ChapterDraft {
  index: string
  outline: string
  notes: string
  summary: string
}

export function ChapterForm({
  metadata,
  revision,
  onChange
}: {
  /** frontmatter 里的元数据（上游那份，见 useEditorStore 的 EditorTab.metadata） */
  metadata: ChapterMetadata
  /**
   * 这一篇 frontmatter 的**原文**。
   *
   * 只用来判「元数据是不是在别处被改过」（见下面那条 effect）：值变了说明这次变化不是
   * 这个表单造成的，该把草稿重取一遍。同一份内容里它稳定，所以打字不会触发它。
   */
  revision: string
  /** 草稿里能解释成元数据的那一部分变化了。调用方负责写回 model 与 store */
  onChange: (metadata: ChapterMetadata) => void
}): JSX.Element {
  const t = useT()

  /**
   * 用户手上那份草稿，以及**上一次送上去的那一组值**。
   *
   * `sent` 是这一整套的关键。改一个字段要走「写入 model -> 解析 -> store 更新 -> 重渲染」
   * 这一趟才回到这里，而我们在那一趟开头就已经知道它要变成什么了 —— `sent` 记的正是那个
   * 结论。上游那份与它一致，说明这一趟还没绕回来，用户手里的草稿比上游新，得接着用草稿；
   * 对不上，才说明元数据是在别处被改掉的，该重取。
   *
   * 记「值」而不是记「从哪一份变来的」：草稿里可能有读不成号的东西（用户把索引清空了），
   * 那时上游会是「还没有索引」，而草稿本身还不是 —— 两件事必须分得开。
   */
  const [editing, setEditing] = useState<{
    draft: ChapterDraft
    sent: Pick<ChapterMetadata, 'index' | 'outline' | 'notes' | 'summary'>
  } | null>(null)

  /** 上游那份与 `sent` 同值：这一趟已经绕回来了，用上游那份；否则用草稿 */
  const sent = editing?.sent ?? null
  const draft = editing?.draft ?? null
  const active =
    sent !== null && draft !== null && sameMetadata(metadata, sent) ? draft : toDraft(metadata)

  /**
   * 这个表单**自己**送出去的那一组值的指纹。
   *
   * 用来把「自己写出去的」与「别处改掉的」分开：前者不该重置草稿（正是它保住了用户正在
   * 敲的那个字符串 —— 用户敲到一半的 `1` 还不是合法索引，上游却已经在解析它了），后者
   * 必须重置（用户在纯文本视图里改了 frontmatter，切回表单时该看到改过之后的那一份）。
   *
   * 判据用值本身而不是「从哪一份变来的」：同一份内容往返一趟之后值必然相等，而与来源
   * 无关 —— 上游那次写入无论是这个表单发的还是宿主发的，只要值对得上，草稿就是最新的。
   */
  const sentRef = useRef<string | null>(null)

  useEffect(() => {
    // 上游那一份与刚送出去的一致：这一趟已经绕回来了，草稿仍然是最新的
    if (sentRef.current !== null && sentRef.current === serialize(metadata)) return

    /**
     * 别处改过（或者前面还什么都没送过）：丢掉草稿，重新取上游那一份。
     *
     * 只在这一刻重置，**不是**每次渲染都重置 —— 后者会把用户敲进去的字冲掉。
     */
    sentRef.current = serialize(metadata)
    setEditing(null)
  }, [revision, metadata])

  /**
   * 提交一份草稿：记下**这次要送上去的值**，再往上送。
   *
   * 索引的解释集中在这里：空、非十进制整数都当成「还没有索引」（null），而 `0` 是序章，
   * 是合法值（见 shared/project/chapters 的文件头）。其余字段原样送。
   */
  const commit = (next: ChapterDraft): void => {
    const values = {
      index: parseIndex(next.index),
      outline: next.outline,
      notes: next.notes,
      summary: next.summary
    }

    sentRef.current = serialize(values)
    setEditing({ draft: next, sent: values })
    onChange({ ...metadata, ...values })
  }

  /**
   * 失焦：把输入框里的号补成规范写法（`1` -> `001`），与写进文件的那个值对上。
   *
   * 刻意**不**在这里 onChange：补零没有改值，而写一次文件的事只该由真正的改动触发。
   * `sent` 保持原样 —— 解释出来的号没变，上游那一趟的结论也没变。
   */
  const normalizeIndex = (): void => {
    setEditing((current) =>
      current === null
        ? current
        : { ...current, draft: { ...current.draft, index: formatIndex(current.draft.index) } }
    )
  }

  return (
    /**
     * 一列字段。高度按内容排 —— 这一格里唯一有高度的东西是调用方摆在下面的那个编辑器。
     *
     * 左右留白**不在这里**：它由承载这一层的滚动容器给（见 EditorPanes 的表单那一格），
     * 那样字段与编辑器共用同一条边距，不会各写一遍再各自漂移。
     */
    <section className="flex flex-col gap-4">
      <Field label={t('host.editor.form.index')} hint={t('host.editor.form.index.hint')}>
        <input
          type="text"
          inputMode="numeric"
          value={active.index}
          onChange={(event) => commit({ ...active, index: event.target.value })}
          // 失焦时把号补成规范写法（`1` -> `001`），与写进文件的那个值对上
          onBlur={normalizeIndex}
          placeholder={t('host.editor.form.index.placeholder')}
          className="h-7 w-28 rounded border border-zinc-700 bg-zinc-900 px-2 font-mono text-xs text-zinc-100 outline-none focus:border-blue-500"
        />
      </Field>

      <Field label={t('host.editor.form.outline')}>
        <TextArea
          value={active.outline}
          onChange={(value) => commit({ ...active, outline: value })}
          placeholder={t('host.editor.form.outline.placeholder')}
        />
      </Field>

      <Field label={t('host.editor.form.characters')} hint={t('host.editor.form.characters.hint')}>
        <CharacterList names={metadata.characters} />
      </Field>

      <Field label={t('host.editor.form.notes')}>
        <TextArea
          value={active.notes}
          onChange={(value) => commit({ ...active, notes: value })}
          placeholder={t('host.editor.form.notes.placeholder')}
        />
      </Field>

      <Field label={t('host.editor.form.summary')}>
        <TextArea
          value={active.summary}
          onChange={(value) => commit({ ...active, summary: value })}
          placeholder={t('host.editor.form.summary.placeholder')}
        />
      </Field>
    </section>
  )
}

/**
 * 出场角色：只读。
 *
 * 图鉴还没实现（见 ProjectsPanel 里另外三个分类的占位），所以这里既不能选、也不能手写
 * —— 但**要把文件里已有的那几个显示出来**：它们已经在稿子里了，藏起来会让人以为元数据
 * 丢了。等到能选的那一天，这个组件换成从图鉴里挑人的输入框即可。
 */
function CharacterList({ names }: { names: readonly string[] }): JSX.Element {
  const t = useT()

  if (names.length === 0) {
    return <p className="text-xs text-zinc-500">{t('host.editor.form.characters.empty')}</p>
  }

  return (
    <ul className="flex flex-wrap gap-1">
      {names.map((name) => (
        <li
          key={name}
          className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300"
          // 悬停说清「为什么点不动」：一个没有说明的禁用控件只会让人反复点它
          title={t('host.editor.form.characters.hint')}
        >
          {name}
        </li>
      ))}
    </ul>
  )
}

/** 一个字段：左边固定宽度的标签，右边控件。宽度固定是为了让所有控件左边缘对齐 */
function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex min-w-0 gap-3">
      <div className="flex w-20 shrink-0 flex-col gap-0.5 pt-1">
        <span className="text-xs text-zinc-300">{label}</span>
        {hint && <span className="text-[10px] leading-3 text-zinc-500">{hint}</span>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** 多行文本字段。样式统一在这里，调用点只给值与回调 */
function TextArea({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}): JSX.Element {
  return (
    <textarea
      value={value}
      rows={3}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="nide-scrollbar w-full resize-y rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs leading-5 text-zinc-100 outline-none focus:border-blue-500"
    />
  )
}

// ============ 草稿与元数据之间的换算 ============

function toDraft(metadata: ChapterMetadata): ChapterDraft {
  return {
    index: metadata.index === null ? '' : formatChapterNumber(metadata.index),
    outline: metadata.outline,
    notes: metadata.notes,
    summary: metadata.summary
  }
}

/**
 * 两份元数据在**表单管得着的**那几项上是不是同一个值。
 *
 * 只比这四项：`category`（它决定有没有这个表单）与 `characters`（还不能编辑）不由这一层
 * 产生，拿它们一起比会把「宿主改了出场角色」也判成「用户这份草稿过期了」。
 */
function sameMetadata(
  metadata: ChapterMetadata,
  other: Pick<ChapterMetadata, 'index' | 'outline' | 'notes' | 'summary'>
): boolean {
  return (
    metadata.index === other.index &&
    metadata.outline === other.outline &&
    metadata.notes === other.notes &&
    metadata.summary === other.summary
  )
}

/**
 * 那四项的指纹，用来判「上游这一趟是不是自己刚发出去的那一趟」。
 *
 * JSON 而不是手写比较：形状固定（四个字段，其中一个是数字或 null），序列化一次比写
 * 四行 `===` 更不容易漏项，而它只在表单提交与上游变化时各跑一次。
 */
function serialize(
  values: Pick<ChapterMetadata, 'index' | 'outline' | 'notes' | 'summary'>
): string {
  return JSON.stringify([values.index, values.outline, values.notes, values.summary])
}

/** 索引：空或不是十进制整数时给 null（「还没有索引」）；`0` 是序章，照收 */
function parseIndex(raw: string): number | null {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return null

  const value = Number(trimmed)
  return Number.isSafeInteger(value) ? value : null
}

/** 失焦时把输入框里的号补成规范写法；读不成号时原样留着，让用户自己看到那份输入 */
function formatIndex(raw: string): string {
  const value = parseIndex(raw)
  return value === null ? raw : formatChapterNumber(value)
}
