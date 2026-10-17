import { JSX, useEffect } from 'react'
import { galleryEntryFields } from '@shared/project'
import { FormField, FormTextArea } from '@renderer/editor/form-controls'
import { applyGalleryEntryValues, syncGalleryForm } from '@renderer/editor/gallery-metadata'
import { useExplorerStore } from '@renderer/stores/explorer.store'
import { galleryOfPath, useGalleryStore } from '@renderer/stores/gallery.store'
import { useT } from '@renderer/stores/i18n.store'
import type { EditorTab } from '@renderer/stores/editor.store'

/**
 * 图鉴条目的表单：把一个图鉴的字段摆成一组输入框。
 *
 * ```
 * 名称   ［主角            ］
 * 外貌   ［黑发，左眼有疤   ］
 * ```
 *
 * ## 字段从哪儿来
 *
 * 图的字段表在**所属图鉴的 `config.yml`** 里（见 shared/project/gallery），所以这一层
 * 向 gallery store 要那个图鉴的字段。文件里多出来的键（字段被改名或删掉之后留下的旧
 * 键）**跟在后面一起显示**：它们写在用户的文件里，藏起来只会让人以为数据丢了，而写回
 * 时它们会被原样保留（见 galleryEntryFields）。
 *
 * 图鉴读不出来（文件不在图鉴目录里、列表还没到）时**只按文件自己的键渲染**：那一份
 * 仍然是对的，只是顺序没了依据 —— 表单永远不该因为「暂时不知道字段表」就不给编辑。
 *
 * ## 没有草稿
 *
 * 与章节表单不同，这里没有「用户手上那份草稿」：字段值是**任意文本**，没有「敲到一半
 * 还不是合法值」这一档（章节的索引有：`1` 与 `10` 之间那个状态不是编号）。所以每次
 * 输入直接写回 model，再由 model 推回 store，输入框显示的就是磁盘上将会有的那一份。
 */
export function GalleryEntryForm({
  tab,
  syncing
}: {
  tab: EditorTab
  /** 「这次 model 写入是宿主发起的」标记，与编辑器那一层共用同一个 */
  syncing: { current: boolean }
}): JSX.Element {
  const t = useT()
  const galleries = useGalleryStore((s) => s.galleries)
  const loadGalleries = useExplorerStore((s) => s.loadGalleries)

  /*
   * 补一次图鉴列表：字段表在 gallery store 里，而「项目」那一面可能从来没挂载过
   * （打开一个条目完全可能只走文件树）。这一步幂等，读过就不重读。
   */
  useEffect(() => {
    void loadGalleries()
  }, [loadGalleries])

  /*
   * 表单模式里没有编辑器，model 得有人建出来并让它与标签页上那份正文对齐 —— 保存读的
   * 是 model（见 gallery-metadata 的 syncGalleryForm）。
   */
  useEffect(() => {
    syncGalleryForm(
      {
        path: tab.path,
        language: tab.language,
        originalValue: tab.originalValue,
        content: tab.content
      },
      syncing
    )
  }, [tab.path, tab.language, tab.originalValue, tab.content, syncing])

  const gallery = galleryOfPath(galleries, tab.path)
  const values = tab.gallery.values
  const allFields = galleryEntryFields(values, gallery?.fields ?? [])
  const configured = (gallery?.fields ?? []).filter((field) => field.trim().length > 0)
  const configuredFields = allFields.filter((field) => configured.includes(field))
  const extraFields = allFields.filter((field) => !configured.includes(field))

  /**
   * 一个字段变了：把整组值写回去。
   *
   * 写的是**整组**而不是那一个键，因为顺序也是这一层的信息（见 applyGalleryEntryValues
   * 的 order 参数）。空值留在这一组里、但不会被写进文件（见 formatGalleryEntry）：少了
   * 这个键，输入框会在下一次渲染时回到空串，用户刚敲的字就没了。
   */
  const commit = (field: string, value: string): void => {
    applyGalleryEntryValues(tab.path, { ...values, [field]: value }, allFields, syncing)
  }

  const field = (name: string): JSX.Element => (
    <FormField key={name} label={name}>
      <FormTextArea
        value={values[name] ?? ''}
        onChange={(value) => commit(name, value)}
        rows={2}
        placeholder={t('host.editor.gallery.value.placeholder')}
      />
    </FormField>
  )

  if (allFields.length === 0) {
    return <p className="text-xs text-zinc-500">{t('host.editor.gallery.empty')}</p>
  }

  return (
    <section className="flex flex-col gap-4">
      {configuredFields.map(field)}

      {/* 文件里多出来的键：单独说一句，免得用户以为它们是这个图鉴的字段 */}
      {gallery !== null && extraFields.length > 0 && (
        <p className="text-[11px] leading-4 text-zinc-500">{t('host.editor.gallery.extra')}</p>
      )}

      {extraFields.map(field)}
    </section>
  )
}
