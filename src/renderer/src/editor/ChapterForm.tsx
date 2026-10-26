import { JSX, useEffect, useRef, useState } from 'react'
import { formatChapterNumber, type ChapterMetadata } from '@shared/project'
import { FormField, FormTextArea } from '@renderer/editor/form-controls'
import { BuiltinIcon } from '@nide/client-kit/ui/BuiltinIcon'
import { useExplorerStore } from '@nide/client-kit/stores/explorer.store'
import { characterGalleryOf, useGalleryStore } from '@nide/client-kit/stores/gallery.store'
import { useT } from '@nide/client-kit/stores/i18n.store'

/**
 * 章节表单：把 frontmatter 里的那几项元数据摆成一组字段。
 *
 * ## 从上到下
 *
 * ```
 * 索引         ［输入框］
 * 细纲         ［多行文本］
 * 出场角色      ［标签 + 从图鉴里选 / 直接输入］
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
 * ## 出场角色从角色图鉴里选
 *
 * 「谁是角色」这件事由**图鉴**回答（见 shared/project/gallery）：`.nide/config.yml`
 * 里图鉴那一段的 `characters` 记着哪个图鉴是角色图鉴，那一份图鉴的每个条目就是一个
 * 角色。这里给出它的条目当建议，
 * 但仍然**允许手写** —— 一个还没建档的群众演员照样要能写进这一章的出场角色里，而
 * 「先建条目再回来填」多出来的那一步不会让任何人更准确。
 *
 * 存进 frontmatter 的是**名字**（条目的第一个字段），不是路径：稿件要能被别的编辑器
 * 读懂，而一个指向图鉴文件的相对路径会把「这一章有谁」变成一个只有宿主答得上来的问题。
 */
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
    sent: Pick<ChapterMetadata, 'index' | 'outline' | 'characters' | 'notes' | 'summary'>
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
      characters: next.characters,
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
     * 左右留白**不在这里**：它由调用方那一层给（见 EditorPanes 表单那一格），而且只给
     * 字段这一层 —— 正文编辑器贴着窗口两边（编辑器是写字的地方，边距会把它变成一个
     * 窗口里的小框），两者因此不再共用同一条边距。
     */
    <section className="flex flex-col gap-4">
      <FormField label={t('host.editor.form.index')} hint={t('host.editor.form.index.hint')}>
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
      </FormField>

      <FormField label={t('host.editor.form.outline')}>
        <FormTextArea
          value={active.outline}
          onChange={(value) => commit({ ...active, outline: value })}
          placeholder={t('host.editor.form.outline.placeholder')}
        />
      </FormField>

      <FormField
        label={t('host.editor.form.characters')}
        hint={t('host.editor.form.characters.hint')}
      >
        <CharacterPicker
          names={active.characters}
          onChange={(names) => commit({ ...active, characters: names })}
        />
      </FormField>

      <FormField label={t('host.editor.form.notes')}>
        <FormTextArea
          value={active.notes}
          onChange={(value) => commit({ ...active, notes: value })}
          placeholder={t('host.editor.form.notes.placeholder')}
        />
      </FormField>

      <FormField label={t('host.editor.form.summary')}>
        <FormTextArea
          value={active.summary}
          onChange={(value) => commit({ ...active, summary: value })}
          placeholder={t('host.editor.form.summary.placeholder')}
        />
      </FormField>
    </section>
  )
}

/**
 * 出场角色：一组标签 + 一个「从角色图鉴里选」的输入框。
 *
 * 三条刻意的行为：
 *
 * - **可以直接输入**。图鉴是建议的来源，不是许可：写一场只有一句台词的戏时，为一个
 *   群众演员先建一个条目再回来填，比直接敲下他的名字慢得多；
 * - **录入前先去掉首尾空白**，并且同一个名字只留一份（frontmatter 里那个列表的语义是
 *   集合，重复写两遍只会让「这一章有谁」变得难读）；
 * - **建议里排掉已经加过的名字**：一个点了没有反应的候选，比一个不出现的候选更让人
 *   怀疑这个框坏了。
 */
function CharacterPicker({
  names,
  onChange
}: {
  names: readonly string[]
  onChange: (names: string[]) => void
}): JSX.Element {
  const t = useT()
  const galleries = useGalleryStore((s) => s.galleries)
  const registry = useGalleryStore((s) => s.registry)
  const loadGalleries = useExplorerStore((s) => s.loadGalleries)

  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  /*
   * 补一次图鉴列表：角色图鉴的条目就是建议的来源，而「项目」那一面可能从没挂载过。
   * 幂等（读过就不重读），所以每次打开一章都问一次是安全的。
   */
  useEffect(() => {
    void loadGalleries()
  }, [loadGalleries])

  const gallery = characterGalleryOf(galleries, registry)
  const available = (gallery?.entries ?? [])
    .map((entry) => entry.label)
    .filter((label) => label.length > 0 && !names.includes(label))

  const trimmed = query.trim()
  const matches =
    trimmed.length === 0
      ? available
      : available.filter((label) => label.toLowerCase().includes(trimmed.toLowerCase()))

  const add = (name: string): void => {
    const value = name.trim()
    setQuery('')

    if (value.length === 0 || names.includes(value)) return
    onChange([...names, value])
  }

  const remove = (name: string): void => {
    onChange(names.filter((item) => item !== name))
  }

  return (
    <div className="flex flex-col gap-2">
      {names.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {names.map((name) => (
            <li
              key={name}
              className="flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-zinc-300"
            >
              {name}
              <button
                type="button"
                aria-label={t('host.editor.form.characters.remove', { name })}
                title={t('host.editor.form.characters.remove', { name })}
                onClick={() => remove(name)}
                className="rounded p-0.5 text-zinc-500 transition-colors hover:bg-zinc-700 hover:text-zinc-200"
              >
                <BuiltinIcon name="close" className="h-2.5 w-2.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return

            // 回车 = 把输入框里那个名字收下（不提交整个表单：这里是本章的一个字段）
            event.preventDefault()
            add(query)
          }}
          placeholder={t('host.editor.form.characters.placeholder')}
          className="h-7 w-56 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100 outline-none focus:border-blue-500"
        />

        {open && matches.length > 0 && (
          <ul className="nide-scrollbar absolute top-8 left-0 z-20 max-h-48 w-56 overflow-y-auto rounded border border-zinc-700 bg-zinc-800 py-1 shadow-lg shadow-black/50">
            {matches.map((label) => (
              <li key={label}>
                {/*
                  mousedown 上 preventDefault：不这样做的话，按下鼠标会让输入框先失焦，
                  而失焦会把这一份候选列表收掉 —— 于是「点一个候选」永远点不中。
                */}
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => add(label)}
                  className="block w-full px-2 py-1 text-left text-xs text-zinc-200 transition-colors hover:bg-zinc-700"
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        一个建议都没有、而且没有角色图鉴时说清楚为什么：空白的输入框看起来像坏了，
        而真正的原因是「还没有哪个图鉴被设为角色图鉴」（见 .nide/config.yml 的 gallery）。
      */}
      {gallery === null && (
        <p className="text-[10px] leading-3 text-zinc-500">
          {t('host.editor.form.characters.missing')}
        </p>
      )}
    </div>
  )
}

// ============ 草稿与元数据之间的换算 ============

/** 表单里各字段的草稿。与 ChapterMetadata 的差别只有索引：这里是用户正在敲的那个字符串 */
interface ChapterDraft {
  index: string
  outline: string
  characters: string[]
  notes: string
  summary: string
}

function toDraft(metadata: ChapterMetadata): ChapterDraft {
  return {
    index: metadata.index === null ? '' : formatChapterNumber(metadata.index),
    outline: metadata.outline,
    characters: [...metadata.characters],
    notes: metadata.notes,
    summary: metadata.summary
  }
}

/**
 * 两份元数据在**表单管得着的**那几项上是不是同一个值。
 *
 * 只比这五项：`category` 不由这一层产生，拿它一起比会把「宿主改了类别」也判成
 * 「用户这份草稿过期了」。
 */
function sameMetadata(
  metadata: ChapterMetadata,
  other: Pick<ChapterMetadata, 'index' | 'outline' | 'characters' | 'notes' | 'summary'>
): boolean {
  return (
    metadata.index === other.index &&
    metadata.outline === other.outline &&
    sameTexts(metadata.characters, other.characters) &&
    metadata.notes === other.notes &&
    metadata.summary === other.summary
  )
}

/**
 * 那五项的指纹，用来判「上游这一趟是不是自己刚发出去的那一趟」。
 *
 * JSON 而不是手写比较：形状固定（四个字符串或 null + 一个字符串数组），序列化一次比
 * 写五行 `===` 更不容易漏项，而它只在表单提交与上游变化时各跑一次。
 */
function serialize(
  values: Pick<ChapterMetadata, 'index' | 'outline' | 'characters' | 'notes' | 'summary'>
): string {
  return JSON.stringify([
    values.index,
    values.outline,
    values.characters,
    values.notes,
    values.summary
  ])
}

/** 两个角色列表是不是同一组（顺序也算：用户看到的顺序就是这里存着的那个） */
function sameTexts(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
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
