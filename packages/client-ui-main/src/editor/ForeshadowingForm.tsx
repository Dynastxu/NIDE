import { JSX, useEffect } from 'react'
import {
  applyForeshadowingMetadata,
  syncForeshadowingForm
} from '@nide/client-ui-main/editor/foreshadowing-metadata'
import { FormField, FormTextArea } from '@nide/client-ui-main/editor/form-controls'
import { useT } from '@nide/client-kit/stores/i18n.store'
import type { EditorTab } from '@nide/client-kit/stores/editor.store'

/**
 * 伏笔表单：四个**固定**字段。
 *
 * ```
 * 名称       ［主角的身世          ］
 * 起始章节   ［003                 ］
 * 结束章节   ［012                 ］
 * 描述       ［第一章埋下的玉佩……  ］
 * ```
 *
 * 与章节、图鉴表单的排版共用同两种控件（见 form-controls），差别只在这里不需要字段表：
 * 四个字段由 shared/project/foreshadowing 定死，界面不按配置生成，也不接受额外的键。
 *
 * ## 没有草稿
 *
 * 四个字段都是**任意文本**，没有「敲到一半还不是合法值」这一档（章节的索引有：`1`
 * 与 `10` 之间那个状态不是编号）。所以每次输入直接写回 model，再由 model 推回 store，
 * 输入框显示的就是磁盘上将会有的那一份。
 *
 * ## 没有正文编辑器
 *
 * 伏笔的内容全在这四个字段里，文件本身没有正文可言。表单因此是整块可滚的一列字段
 * （见 EditorPanes 的伏笔分支），model 由 syncForeshadowingForm 建出来 —— 保存读的
 * 正是它。
 */
export function ForeshadowingForm({
  tab,
  syncing
}: {
  tab: EditorTab
  /** 「这次 model 写入是宿主发起的」标记，与编辑器那一层共用同一个 */
  syncing: { current: boolean }
}): JSX.Element {
  const t = useT()
  const metadata = tab.foreshadowing

  /*
   * 表单模式里没有编辑器，model 得有人建出来并让它与标签页上那份正文对齐 —— 保存读的
   * 是 model（见 foreshadowing-metadata 的 syncForeshadowingForm）。
   */
  useEffect(() => {
    syncForeshadowingForm(
      {
        path: tab.path,
        language: tab.language,
        originalValue: tab.originalValue,
        content: tab.content
      },
      syncing
    )
  }, [tab.path, tab.language, tab.originalValue, tab.content, syncing])

  /** 一个字段变了：把整条元数据写回去。category 由上游那份保留，不由表单产生 */
  const commit = (patch: Partial<typeof metadata>): void => {
    applyForeshadowingMetadata(tab.path, { ...metadata, ...patch }, syncing)
  }

  return (
    <section className="flex flex-col gap-4">
      <FormField label={t('host.editor.form.foreshadowing.name')}>
        <input
          type="text"
          value={metadata.name}
          onChange={(event) => commit({ name: event.target.value })}
          placeholder={t('host.editor.form.foreshadowing.name.placeholder')}
          className="h-7 w-72 max-w-full rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100 outline-none focus:border-blue-500"
        />
      </FormField>

      <FormField
        label={t('host.editor.form.foreshadowing.start')}
        hint={t('host.editor.form.foreshadowing.chapter.hint')}
      >
        <input
          type="text"
          value={metadata.startChapter}
          onChange={(event) => commit({ startChapter: event.target.value })}
          placeholder={t('host.editor.form.foreshadowing.chapter.placeholder')}
          className="h-7 w-28 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100 outline-none focus:border-blue-500"
        />
      </FormField>

      <FormField label={t('host.editor.form.foreshadowing.end')}>
        <input
          type="text"
          value={metadata.endChapter}
          onChange={(event) => commit({ endChapter: event.target.value })}
          placeholder={t('host.editor.form.foreshadowing.chapter.placeholder')}
          className="h-7 w-28 rounded border border-zinc-700 bg-zinc-900 px-2 text-xs text-zinc-100 outline-none focus:border-blue-500"
        />
      </FormField>

      <FormField label={t('host.editor.form.foreshadowing.description')}>
        <FormTextArea
          value={metadata.description}
          onChange={(value) => commit({ description: value })}
          placeholder={t('host.editor.form.foreshadowing.description.placeholder')}
          rows={5}
        />
      </FormField>
    </section>
  )
}
