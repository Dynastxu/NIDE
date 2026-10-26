import {
  isChapterDocument,
  isForeshadowingDocument,
  isForeshadowingPath,
  isGalleryConfigFileName,
  isGalleryEntryDocument,
  isGalleryEntryPath,
  isMarkdownPath
} from '@shared/project'
import type {
  ChapterMetadata,
  ForeshadowingMetadata,
  GalleryConfig,
  GalleryEntryDocument
} from '@shared/project'
import type { DocumentViewMode } from '@nide/client-kit/stores/document-view.store'

/**
 * 「这一篇在编辑器里能怎么看」的判据。
 *
 * 一切都只由**文件自己**决定（扩展名 + 文件里写着的类别），与它在哪个目录里、当前
 * 项目配置成什么样都无关 —— 一个放在 `chapters/` 里的 README 是 README，一个放在
 * 项目根的 `第3章.md` 只要写着类别就是章节。
 *
 * 放在这个文件里而不是散在组件中：工具栏要按它决定画几个按钮、正文要按它决定渲染
 * 哪一种视图、默认值也要按它算 —— 三处各写一遍判据，迟早会有一处分叉，而分叉的
 * 表现是「按钮说能填表单、正文却给了一段纯文本」。所以这里是**一个**结论对象
 * （见 `documentViewOf`），三处消费的是同一份。
 *
 * ## 三个消费方各要什么
 *
 * | 消费方 | 要的 |
 * |---|---|
 * | 标题栏的视图按钮组 | `modes`（空数组表示这一篇没有可切换的看法，不给按钮） |
 * | 正文那一层 | `kind`（决定表单画哪一份）+ 默认模式 |
 * | 打开文件那一刻 | `defaultMode` |
 */

/** 这一篇在编辑器里属于哪一类。取值决定有没有表单、表单画哪一份 */
export type DocumentKind =
  'plain' | 'markdown' | 'chapter' | 'foreshadowing' | 'gallery-entry' | 'gallery-config'

/** 判据的输入：一个打开着的文件所能提供的事实 */
export interface DocumentViewInput {
  /** Monaco 的语言 id（由路径推导，见 shared/project 的 languageForPath） */
  language: string
  /** 文件绝对路径 */
  path: string
  /** 章节 frontmatter 的解析结果 */
  chapter: ChapterMetadata
  /** 伏笔 yml 的解析结果 */
  foreshadowing: ForeshadowingMetadata
  /** yml 顶层的类别与字段 */
  gallery: GalleryEntryDocument
  /**
   * `config.yml` 的字段表。
   *
   * 不是那个文件名时由调用方给 null（不必为每个文件解析一遍）；是那个文件名但读不
   * 出来时也给 null —— 判据的另一半在 `parseGalleryConfig`，见下面的说明。
   */
  galleryConfig: GalleryConfig | null
}

/** 一个文件能怎么看：它是哪一类、有哪几种看法、默认停在哪一种 */
export interface DocumentView {
  kind: DocumentKind
  /** 标题栏上该给出的那几个按钮。空数组表示不画这一组 */
  modes: DocumentViewMode[]
  defaultMode: DocumentViewMode
}

/**
 * 一个标签页 -> 判据的输入。
 *
 * 有这一层是因为 EditorTab 还带着正文、脏标记这些与「能怎么看」无关的东西，而判据只
 * 需要那五样事实。放这里而不是让每个调用点自己拼：拼错的字段（例如把 `metadata` 写成
 * `chapter`）会编译不过，而调用点因此也只有一处。
 */
export function documentViewInputOf(tab: {
  language: string
  path: string
  metadata: ChapterMetadata
  foreshadowing: ForeshadowingMetadata
  gallery: GalleryEntryDocument
  galleryConfig: GalleryConfig | null
}): DocumentViewInput {
  return {
    language: tab.language,
    path: tab.path,
    chapter: tab.metadata,
    foreshadowing: tab.foreshadowing,
    gallery: tab.gallery,
    galleryConfig: tab.galleryConfig
  }
}

/** 这一篇能不能用 Markdown 预览（也就是：界面要不要给出预览那一档） */
export function canPreviewDocument(language: string, path: string): boolean {
  return language === 'markdown' || isMarkdownPath(path)
}

/**
 * 这一篇是不是章节。
 *
 * 判据是 frontmatter 里的类别，**不是**它在不在章节目录里：用户在章节目录里放一篇
 * 写作笔记是常态，而给笔记弹一个「索引 / 细纲」表单只是噪声。
 */
export function isChapterTab(input: DocumentViewInput): boolean {
  return canPreviewDocument(input.language, input.path) && isChapterDocument(input.chapter)
}

/**
 * 这一篇是不是伏笔。
 *
 * 两个条件缺一不可：
 *
 * - **扩展名是 `.yml` / `.yaml`**（`FORESHADOWING_FILE_EXTENSIONS`）。表单会把整份
 *   文件按 YAML 重写，所以一个写着 `category: foreshadowing` 的 `.md` 不能当伏笔 ——
 *   那样表单保存一次就等于在一份 Markdown 里塞进一段 YAML；
 * - **文件里写着伏笔的类别**（不看在哪个目录里，与章节同一条理由）。
 */
export function isForeshadowingTab(input: DocumentViewInput): boolean {
  return isForeshadowingPath(input.path) && isForeshadowingDocument(input.foreshadowing)
}

/**
 * 这一篇是不是图鉴条目。
 *
 * 两个条件缺一不可：
 *
 * - **扩展名是 yml**（`GALLERY_ENTRY_EXTENSIONS`）。表单会把整份文件按 YAML 重写，
 *   所以一个写着 `category: gallery` 的 `.md` 不能当图鉴 —— 那样表单保存一次就等于
 *   把正文删了；
 * - **文件里写着图鉴的类别**（不看在哪个目录里，与章节同一条理由）。
 */
export function isGalleryEntryTab(input: DocumentViewInput): boolean {
  return isGalleryEntryPath(input.path) && isGalleryEntryDocument(input.gallery)
}

/**
 * 这一篇是不是图鉴的字段表（`config.yml`）。
 *
 * 同样两个条件：文件名是 `config.yml`，**并且**内容读得出来是一份字段表。只看名字的话，
 * 项目里任何一个同名的 yml 都会被当成图鉴配置，而表单会按字段表重写它 —— 那是替用户
 * 改一份宿主并不认识的配置文件。
 */
export function isGalleryConfigTab(input: DocumentViewInput): boolean {
  return isGalleryConfigFileName(input.path) && input.galleryConfig !== null
}

/**
 * 这一篇属于哪一类。
 *
 * 顺序上先判图鉴配置、再判图鉴条目、最后判伏笔：三者互斥（一个要文件名是
 * `config.yml`、一个要扩展名是 yml 且带图鉴类别、一个要 yml 且带伏笔类别），先判
 * 更窄的那一个读起来更清楚。非 Markdown 的文件在判完这几类之后就是纯文本 —— 它没有
 * 预览可言。
 */
export function documentKindOf(input: DocumentViewInput): DocumentKind {
  if (isGalleryConfigTab(input)) return 'gallery-config'
  if (isGalleryEntryTab(input)) return 'gallery-entry'
  if (isForeshadowingTab(input)) return 'foreshadowing'
  if (!canPreviewDocument(input.language, input.path)) return 'plain'
  if (isChapterDocument(input.chapter)) return 'chapter'

  return 'markdown'
}

/**
 * 一类文件有哪几种看法。
 *
 * 表单只对章节、伏笔与图鉴出现：一个会给普通文档补出 `category: chapter` 的表单，
 * 比没有表单糟得多。伏笔与图鉴一样是 yml，没有「预览」可言，所以也不给预览与拆分；
 * 章节之外的文件只有纯文本与表单两档。
 */
export function availableDocumentModes(kind: DocumentKind): DocumentViewMode[] {
  switch (kind) {
    case 'chapter':
      return ['text', 'form', 'split', 'preview']
    case 'foreshadowing':
      return ['text', 'form']
    case 'markdown':
      return ['text', 'split', 'preview']
    case 'gallery-entry':
    case 'gallery-config':
      return ['text', 'form']
    default:
      return []
  }
}

/**
 * 打开一个文件时默认落在哪个模式。
 *
 * 三条：
 *
 * - **章节、伏笔与图鉴默认表单**：它们打开来就是为了改元数据（章节的索引与细纲、
 *   伏笔的四个字段、图鉴的字段），而章节的正文本来就在表单旁边；
 * - **其余 Markdown 默认预览**：没有类别的 Markdown 多半是文档（README、笔记），
 *   打开它是为了读，不是为了改；
 * - **其余一律纯文本**。
 */
export function defaultDocumentModeOf(kind: DocumentKind): DocumentViewMode {
  switch (kind) {
    case 'chapter':
    case 'foreshadowing':
    case 'gallery-entry':
    case 'gallery-config':
      return 'form'
    case 'markdown':
      return 'preview'
    default:
      return 'text'
  }
}

/** 这一类文件能怎么看：三处消费的同一个结论 */
export function documentViewOf(input: DocumentViewInput): DocumentView {
  const kind = documentKindOf(input)

  return { kind, modes: availableDocumentModes(kind), defaultMode: defaultDocumentModeOf(kind) }
}

/**
 * 用户选过的模式，与当前这一篇能给的模式对不上时回落到默认值。
 *
 * 需要这一层是因为模式按**路径**记（见 document-view.store）：用户给一篇 Markdown
 * 选过「拆分」，之后这个文件在纯文本模式里被改成了一份普通 yml —— 存着的那个模式
 * 已经不在 `modes` 里了，照它渲染就会画出一个这一类文件不该有的界面。
 */
export function resolveDocumentMode(
  stored: DocumentViewMode | undefined,
  view: DocumentView
): DocumentViewMode {
  return stored !== undefined && view.modes.includes(stored) ? stored : view.defaultMode
}
