import { JSX, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import { monacoLoader } from '@renderer/monaco-env'
import { ChapterForm } from '@renderer/editor/ChapterForm'
import { ForeshadowingForm } from '@renderer/editor/ForeshadowingForm'
import { GalleryConfigForm } from '@renderer/editor/GalleryConfigForm'
import { GalleryEntryForm } from '@renderer/editor/GalleryEntryForm'
import { MarkdownPreview } from '@renderer/editor/MarkdownPreview'
import { applyChapterBody } from '@renderer/editor/chapter-body'
import { applyChapterMetadata } from '@renderer/editor/chapter-metadata'
import {
  bodyModelFor,
  ensureBodyModel,
  ensureModel,
  modelFor,
  pathOfBodyModel,
  pathOfModel,
  writeModelSilently
} from '@renderer/editor/model-registry'
import { saveActiveTab } from '@renderer/editor/editor-save'
import { loggerFor } from '@nide/client-kit/logger'
import { useEditorStore, type EditorTab } from '@nide/client-kit/stores/editor.store'
import { chapterBodyOf, splitFrontmatter } from '@shared/project'
import type { DocumentView } from '@renderer/editor/document-mode'
import type { DocumentViewMode } from '@nide/client-kit/stores/document-view.store'

const logger = loggerFor('editor')

/**
 * 主编辑区的正文：按当前文件的视图模式，把 Monaco 放到不同的位置上。
 *
 * ```
 * text        表单                拆分                预览
 * ┌────────┐  ┌────────────────┐  ┌──────┬──────┐    ┌──────┐
 * │        │  │ 索引 / 细纲     │  │      │      │    │      │
 * │ Monaco │  │ 角色 / 正文     │  │Monaco│ 预览 │    │ 预览 │
 * │        │  │ 备注 / 概述     │  │      │      │    │      │
 * └────────┘  └────────────────┘  └──────┴──────┘    └──────┘
 * ```
 *
 * ## 高度有两种给法
 *
 * 「纯文本 / 拆分 / 预览」里那一格是**弹性列的直接子元素**（`flex-col` 里的 `flex-1`）：
 * 它的高度由 flex 布局直接给出，编辑器量到的就是「剩下多少地方」。
 *
 * 「表单」里那一格反过来 —— 高度**按内容给**（`getContentHeight`，见 fitBodyHeight），
 * 不矮于那一格看得见的区域：那一格整块可滚，编辑器自己不再是一条内部滚动的小窗口。
 *
 * 两者都刻意**不**用网格叠层：`grid` 的默认行轨道是 `auto`，而编辑器那一格的内容是
 * Monaco 自己绝对定位出来的层、不贡献高度 —— 行会塌成 0，编辑器什么都画不出来。
 *
 * ## 编辑器容器由 React 直接渲染
 *
 * 这是第三次修同一个毛病之后定下来的写法：容器**就是**那一格里 React 渲染出来的一个
 * `div`（`ref` 直接挂在它上面），不再有「自己 createElement、再 appendChild 搬来搬去」
 * 这一步。搬来搬去的那两版都出过错，而且都是**静默**的：
 *
 * - 容器还没进文档时 Monaco 就把它建出来了（量到 0×0，之后再也不会自己长回来）；
 * - 挂进去之后没有任何东西主动去量尺寸，`ResizeObserver` 又不会为「已经处在最终尺寸」
 *   的元素补一次通知 —— 于是「等尺寸」那一等就是永远。
 *
 * 现在：`ref` 拿到的元素一定在文档里（函数 ref 在提交阶段就跑完了），而建编辑器就在
 * 同一个 effect 里、紧接着量一次尺寸，量不到就等下一次（见 MonacoHost）。
 *
 * ## 编辑器实例只有一个
 *
 * Monaco 是**挂载代价最高**的东西：`loader.init()` 是异步的，实例本身带着撤销历史、
 * 光标与滚动位置。实例只建一次（见 MonacoHost），而「纯文本 / 拆分 / 预览」三种模式
 * 共用**同一处 JSX 位置**上的那一格 —— 在它们之间切换时 React 会把那个 `div` 连同里面
 * 的编辑器一起挪过去，实例与历史都跟着走。
 *
 * 切到「表单」时那一格换到另一处 JSX 位置（表单字段之后），组件会重新挂载、编辑器因此
 * 重建一次，绑的也是另一份 model（只有正文的那一份，见 MonacoHost 的 `content`）。这是
 * **刻意接受**的代价：把同一个实例在两种布局之间搬来搬去，正是前面几版出错的地方
 * （容器还没进文档就被建出来、或者永远等不到一次尺寸测量）。重建只影响撤销历史与光标
 * 位置，正文本身在 model 里、一个字都不会丢。
 *
 * ## 表单有两种，差别在有没有编辑器
 *
 * 「表单」这一档实际画什么由 `view.kind` 决定：
 *
 * | 是哪一篇 | 表单 | 编辑器 |
 * |---|---|---|
 * | 章节 | 索引 / 细纲 / 角色 / 备注 / 概述 | 有：正文（只有正文的那一份 model） |
 * | 伏笔 | 名称 / 起始章节 / 结束章节 / 描述 | **没有**：四个字段就是全部内容 |
 * | 图鉴条目 | 图鉴的各个字段 | **没有**：整份文件就是那些字段 |
 * | 图鉴字段表 | 字段名列表 | **没有**：同上 |
 *
 * 后两种因此没有「正文」可言（见 GalleryEntryForm）：同一份数据在同一屏里显示两遍
 * 只会让人分不清改的是哪一份。代价是 model 得由表单自己建出来（见 gallery-metadata
 * 的 syncGalleryForm）—— 保存读的是 model，而这里没有哪个 MonacoHost 会顺手建它。
 */
export function EditorPanes({
  tab,
  view,
  mode,
  syncing
}: {
  /** 当前标签页。它的语言、路径与元数据决定这一帧长什么样 */
  tab: EditorTab
  /**
   * 这一篇能怎么看（见 editor/document-mode.ts）。
   *
   * 由 EditorTabs 算好传进来，而不是在这里再判一次：工具栏就在它的隔壁，两处各判一次
   * 就会出现「按钮说能填表单、这里却给了纯文本」。
   */
  view: DocumentView
  /** 当前落在哪一种看法上（已经按可用模式回落过） */
  mode: DocumentViewMode
  /** 「这次 model 写入是宿主发起的」标记，与 MonacoHost 共用同一个（见那里的说明） */
  syncing: { current: boolean }
}): JSX.Element {
  if (mode === 'form' && view.kind === 'gallery-entry') {
    /**
     * 图鉴条目的表单：整块可滚，**没有编辑器**。
     *
     * 与章节表单的差别只有这一点：那里「表单字段」与「正文」是文件里两段互不相干的
     * 内容，所以正文要有一个编辑器；而图鉴条目整份文件就是那些字段 —— 再摆一个编辑器
     * 只会把同一份数据在同一屏里显示两遍。
     *
     * model 仍然会建出来（见 GalleryEntryForm 里的 syncGalleryForm），否则保存没有东西可读。
     */
    return (
      <div className="nide-scrollbar flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="px-4 py-4">
          <GalleryEntryForm tab={tab} syncing={syncing} />
        </div>
      </div>
    )
  }

  if (mode === 'form' && view.kind === 'gallery-config') {
    // 字段表的表单：同样整块可滚、没有编辑器（理由同上）
    return (
      <div className="nide-scrollbar flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="px-4 py-4">
          <GalleryConfigForm tab={tab} syncing={syncing} />
        </div>
      </div>
    )
  }

  if (mode === 'form' && view.kind === 'foreshadowing') {
    /**
     * 伏笔的表单：四个固定字段，整块可滚，**没有编辑器**。
     *
     * 与图鉴条目同一条理由：伏笔的整份 yml 就是那四个字段，文件没有正文可言 —— 再摆
     * 一个编辑器只会把同一份数据在同一屏里显示两遍。model 仍然会建出来（见
     * ForeshadowingForm 里的 syncForeshadowingForm），否则保存没有东西可读。
     */
    return (
      <div className="nide-scrollbar flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="px-4 py-4">
          <ForeshadowingForm tab={tab} syncing={syncing} />
        </div>
      </div>
    )
  }

  if (mode === 'form') {
    /**
     * 表单那一格：元数据字段 + 正文编辑器，整块可滚，宽度铺满主视图。
     *
     * **编辑器与表单是并列的两个子元素**（不是一个嵌在另一个里面）：表单那一层用
     * `key` 绑着 frontmatter 原文（改一个字段就要重新挂载，见 ChapterForm 的说明），
     * 而挂载/卸载会连同子树里的编辑器一起拆掉 —— 那意味着在索引框里每敲一个字符，
     * Monaco 就被销毁重建一次。把编辑器放在它**外面**，这条重挂载路线就与编辑器无关了。
     *
     * 编辑器的高度**按内容长**（见 MonacoHost 的 fitBodyHeight），不矮于这一格看得见的
     * 那一片地方：稿子短时它是一整页可以点下去继续写的地方，稿子长时它跟着长，滚动交给
     * 这一格。
     */
    return (
      /**
       * 表单那一格：整块可滚。
       *
       * 左右留白落在**元数据字段**那一层，不在这里：正文那一格要贴着窗口两边（编辑器
       * 是写字的地方，边距会把它变成一个窗口里的小框 —— 见 MonacoHost 的说明），而
       * 字段贴着窗口边只是难看。两处各自的留白因此各写各的，不再共用父级那一份。
       */
      <div className="nide-scrollbar flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="px-4 pt-4">
          {/*
            **没有 key**：这一层自己管着「用户手上那份草稿」与「上游那份元数据」的对账
            （见 ChapterForm 的说明），改一个字段时它就是靠这份对账保住输入框的。
            给它加 `key`（绑 frontmatter 原文）会让它在每次按键后重新挂载 —— 表现是
            **每敲一个字就丢一次焦点**，而那正是这一层要避免的事。

            「元数据在别处被改过」这件事改由 `revision` 告诉它（frontmatter 原文），
            它在内部判断要不要重取草稿 —— 同样不必重新挂载。
          */}
          <ChapterForm
            metadata={tab.metadata}
            revision={splitFrontmatter(tab.content)?.raw ?? tab.content}
            onChange={(metadata) => applyChapterMetadata(tab.path, metadata, syncing)}
          />
        </div>

        {/* 正文那一格：左右不留白（贴着这一格的两边），高度由 MonacoHost 按内容给 */}
        <div className="pt-4">
          <MonacoHost tab={tab} syncing={syncing} content="chapter-body" className="w-full" />
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/*
        正文那一格。预览模式里它彻底不参与布局（`hidden` = display:none），因为那时
        编辑器在下面预览那一格上。
      */}
      <div
        aria-label={`${tab.name} text`}
        className={[
          'min-h-0 min-w-0',
          // 「拆分」里只占左半边；「纯文本」里是整块
          mode === 'split' ? 'w-1/2' : 'w-full',
          mode === 'preview' ? 'hidden' : 'flex'
        ].join(' ')}
      >
        <MonacoHost tab={tab} syncing={syncing} />
      </div>

      {mode === 'preview' || mode === 'split' ? (
        <div
          aria-label={`${tab.name} preview`}
          className={[
            'flex min-h-0 flex-col overflow-hidden',
            mode === 'split' ? 'w-1/2 border-l border-zinc-800' : 'flex-1'
          ].join(' ')}
        >
          <MarkdownPreview content={tab.content} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * 编辑器那一格。
 *
 * 它由 React 渲染（**不是**搬进来的外部节点），所以：
 *
 * - `ref` 拿到元素时它一定在文档里；
 * - 元素上那句 `data-nide-editor` 说明宿主当前走到哪一步 —— 编辑器画在 React 之外的
 *   DOM 里，没有这一句就完全看不出「为什么没出来」。
 *
 * 容器要铺满这一格，所以它自己不带内边距、边框与滚动：任何一样都会让编辑器量到的尺寸
 * 与这一格不一致。
 *
 * ## 两份内容
 *
 * `content` 说明这一格编辑的是哪一种东西，两者的格式与高度规则都不同：
 *
 * | 取值           | 绑哪一份 model        | 高度             |
 * | -------------- | --------------------- | ---------------- |
 * | `document`     | 整个文件（含元数据）   | 铺满这一格       |
 * | `chapter-body` | 只有正文              | 按内容长（见下） |
 *
 * 表单模式用 `chapter-body`：编辑器里**没有元数据**（那是上面那几个字段的事），改动由
 * editor/chapter-body.ts 接回整篇。两份 model 都由 model-registry 管，谁都不跟着组件走。
 *
 * ## 高度按内容长（`chapter-body`）
 *
 * 见 fitBodyHeight。要点是那一格的高度只能**算**出来，不能交给 CSS：Monaco 画在自己
 * 绝对定位的层里，对布局不贡献任何高度 —— 这正是本文件头部说的那件事。于是「短稿子
 * 也要有一整页可以点下去继续写」这条下限也一并由它给。
 *
 * ## 编辑器与它的 model 在同一步落地
 *
 * `monaco.editor.create` 不带 model 时会**自己建一个空 model**并视其为己有（monaco 里
 * 的 `_ownsModel`），于是编辑器在有人 `setModel` 之前显示的是**空文档**。而「谁来
 * setModel」如果是一条依赖 `ready` 的独立 effect，它有可能永远不跑：创建是异步的，
 * 创建前后那两句 `setReady`（先 false 再 true）很容易落进同一批更新里 —— 状态绕一圈
 * 回到原值，React 判定没有变化，那条 effect 便不再执行，编辑器就停在空 model 上。
 * 现象正是「切换视图模式之后正文偶尔一片空白」，而且它不报任何错。
 *
 * 所以 model 在创建的同一步就定下来（`ensureModel` / `ensureBodyModel` + `create({ model })`），
 * 「切标签页换 model」那条 effect 只负责**换**，不负责补第一次。
 */

/** 这一格里编辑的是哪一种东西 */
type MonacoHostContent = 'document' | 'chapter-body'

/**
 * 「一份文档」的编辑器格式（纯文本 / 拆分 / 预览里那一格）。
 *
 * 行号、装订线、滚动条都留着：这是「一份文件」该有的样子。
 */
const DOCUMENT_EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  minimap: { enabled: false },
  fontSize: 14,
  automaticLayout: true,
  // 小说稿是长文本：默认的 80 列参考线在这种文档里没有意义，而软换行必须开
  wordWrap: 'on',
  scrollBeyondLastLine: false
}

/**
 * 「一章正文」的编辑器格式（表单里那一格）：一段稿子，不是一份代码。
 *
 * 四条由「写小说」这件事定：
 *
 * 1. **没有行号**，连同装行号的那条沟一起收掉：`lineNumbers: 'off'` 只关掉数字本身，
 *    `glyphMargin` 与 `lineDecorationsWidth` 还各占一段空白。
 * 2. **不可滚动**：高度按内容长（见 fitBodyHeight），所以它自己不该再有滚动条。滚轮
 *    交给外面那一格（`handleMouseWheel: false`）—— 光标停在正文里时那一下滚动不该没有
 *    反应，何况在正文上滚与在表单上滚本来就是同一件事。
 * 3. **内部的滚动条与它占的那条带子一起去掉**。只写 `vertical: 'hidden'` 是不够的：
 *    Monaco 的排版里，滚动条的宽度**与可见性无关**地留在右侧（见 editorOptions 的
 *    layoutInfo：`verticalScrollbarWidth = scrollbar.verticalScrollbarSize`，软换行的
 *    列宽还要再减掉它），而概览标尺正好画在那条带子上、宽度也等于它 —— 带子上再画一个
 *    光标标记（`hideCursorInOverviewRuler`），看上去就是一个滚动条。所以宽度一并给 0、
 *    标尺关掉：右边那条带子彻底不存在，正文排到窗口边上。
 * 4. **左右没有边距**：不在选项里，由调用方那一格给（见 EditorPanes 的表单分支）。
 *
 * 「没有元数据」同样不在选项里：那由绑的 model 决定 —— 这一格绑的是只有正文的那一份
 * （见 model-registry 的 ensureBodyModel）。
 */
const CHAPTER_BODY_EDITOR_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  minimap: { enabled: false },
  fontSize: 14,
  automaticLayout: true,
  wordWrap: 'on',
  scrollBeyondLastLine: false,
  lineNumbers: 'off',
  glyphMargin: false,
  folding: false,
  lineDecorationsWidth: 0,
  overviewRulerLanes: 0,
  overviewRulerBorder: false,
  hideCursorInOverviewRuler: true,
  scrollbar: {
    vertical: 'hidden',
    horizontal: 'hidden',
    // 宽度也给 0：可见性关掉的是「画不画」，占位是另一回事（见上面第 3 条）
    verticalScrollbarSize: 0,
    horizontalScrollbarSize: 0,
    handleMouseWheel: false,
    alwaysConsumeMouseWheel: false
  }
}

/**
 * 把正文那一格的高度调成「内容需要的高度」，并且不矮于视图高度（`floor`）。
 *
 * 两件事都做在这一处：高度**先写容器、再让编辑器按同一组数字排一次**。`automaticLayout`
 * 盯的是窗口尺寸，它量到的是这一格当时的大小（含被上一条规则撑出来的那一层），而这里
 * 量出来的（`getContentHeight`）才是这一篇真正需要的地方。
 *
 * 调用方必须**推迟到下一帧**再调它（见 scheduleFitBody）：它改的正是被
 * `ResizeObserver` 观察的容器高度，在 observer 回调或由它触发的 layout effect 里同步
 * 改写，浏览器会持续报「ResizeObserver loop completed with undelivered notifications」。
 */
function fitBodyHeight(
  container: HTMLElement,
  editor: monaco.editor.IStandaloneCodeEditor,
  floor: number
): void {
  const height = Math.max(editor.getContentHeight(), floor)

  // 量不出正的高度（这一格还在 display:none 里）时不动它：写一个 0 进去就是把正文压成一条缝
  if (height <= 0) return

  // 差不到一个像素时不 layout：亚像素的差会让每一次按键都重排一遍
  if (Math.abs(container.getBoundingClientRect().height - height) < 1) return

  container.style.height = `${height}px`
  editor.layout({ width: container.clientWidth, height })
}

/**
 * 「视图高度」：离这个元素**最近的那个可滚动祖先**的可见高度。
 *
 * 认「谁能滚」而不是某个类名或 DOM 位置：表单那一格的排布改过好几次，而判据绑在
 * 「能滚的那一层」上就不会跟着一起改。
 *
 * 一个都找不到时回落到窗口高度：这种情形不该出现（表单那一格本身就能滚），而给 0 的
 * 后果是编辑器永远等不到一个非零尺寸、一个都不建（见上面那条创建 effect）。
 */
function viewportHeightOf(element: HTMLElement): number {
  return scrollableAncestorOf(element)?.clientHeight ?? window.innerHeight
}

/** 离这个元素最近的那个可滚动祖先；一个都没有时给 null */
function scrollableAncestorOf(element: HTMLElement): HTMLElement | null {
  for (let current = element.parentElement; current; current = current.parentElement) {
    const overflowY = getComputedStyle(current).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return current
  }

  return null
}

function MonacoHost({
  tab,
  syncing,
  content = 'document',
  className = 'h-full w-full'
}: {
  /** 当前标签页：路径决定用哪个 model，正文决定写什么 */
  tab: EditorTab
  /** 「这次写入是宿主发起的」标记，见下面那条写入 effect */
  syncing: { current: boolean }
  /** 这一格编辑的是哪一种东西。两种的格式与高度规则都不同（见组件头部） */
  content?: MonacoHostContent
  /** 这一格怎么排（尺寸/留白）。默认铺满父级 —— 整篇文档那一格的用法 */
  className?: string
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [ready, setReady] = useState(false)
  /**
   * 这一格量到的尺寸；还没量到（`display:none` 里、父级还没布局）时是 null。
   *
   * 它同时充当**创建编辑器的信号**：`ResizeObserver` 只在尺寸真的变化时回调，所以这一格
   * 从隐藏变得可见（切回「纯文本」）时它会自己醒过来 —— 不必靠轮询去猜。
   */
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null)
  /**
   * 「视图高度」：这一格看得见的那一片地方有多高（见 viewportHeightOf）。只看 `measured`
   * 是不够的 —— 窗口变化时这一格自己可能一点都不变（按内容长的那一格，高度是算出来的，
   * 不是 CSS 给的），而它的下限跟着视图高度走。
   */
  const [viewport, setViewport] = useState(0)
  /** 已经排进下一帧的那次 fit；0 表示没有 */
  const fitFrameRef = useRef(0)

  /**
   * 把一次「按内容重算高度」推迟到下一帧，并且同一帧只排一次。
   *
   * `fitBodyHeight` 改的是**被 ResizeObserver 观察的容器高度**。在 observer 的回调
   * 触发的 layout effect 里同步改它，浏览器会把这一轮当成「observer 自己改了被观察
   * 元素」—— 表现就是控制台持续刷 `ResizeObserver loop completed with undelivered
   * notifications`。推迟一帧、合并同一帧的多次请求，反馈环就断在这里。
   */
  const scheduleFitBody = useCallback((): void => {
    if (fitFrameRef.current !== 0) return

    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = 0

      const container = containerRef.current
      const editor = editorRef.current
      if (!container || !editor) return

      fitBodyHeight(container, editor, viewportHeightOf(container))
    })
  }, [])

  useEffect(() => {
    return () => {
      if (fitFrameRef.current !== 0) {
        cancelAnimationFrame(fitFrameRef.current)
        fitFrameRef.current = 0
      }
    }
  }, [])

  /**
   * 尺寸变了要重新布局。
   *
   * `automaticLayout` 盯的是**窗口**尺寸，而这一格的宽度会随分隔条与视图模式变化
   * （全宽 / 半宽 / 隐藏）—— 那种变化它看不见，所以测量到新尺寸时主动量一次。
   *
   * 隐藏中（`measured` 为 null）不量：那时量到的是 0×0，对编辑器没有任何意义，
   * 而重新可见时这一次量尺寸会再跑一遍。
   *
   * `ready` 也在依赖里：编辑器是异步建出来的，建好那一下要按它的内容算一次高度
   * （那之前 `measured` 给的是垫底的那一层）。
   */
  useLayoutEffect(() => {
    if (!measured) return

    const editor = editorRef.current
    if (!editor) return

    const container = containerRef.current
    if (content === 'chapter-body' && container) {
      // 不在这一帧里同步改高度：见 scheduleFitBody 的说明
      scheduleFitBody()
      return
    }

    editor.layout()
  }, [measured, viewport, ready, content, scheduleFitBody])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    /**
     * 按内容长的那一格在算出高度之前不能是 0：0 高会让下面那条创建 effect 一直等下去
     * （它要的是量到非零尺寸），而编辑器建不出来就永远算不出内容高度。所以先按视图
     * 高度垫一层 —— 那本来就是它的下限（见 fitBodyHeight）。
     */
    if (content === 'chapter-body' && container.getBoundingClientRect().height <= 0) {
      container.style.height = `${viewportHeightOf(container)}px`
    }

    const observer = new ResizeObserver(() => {
      const { width, height } = container.getBoundingClientRect()

      // 尺寸没变时不重复写 state：否则每次布局都会绕成一轮重渲染
      setMeasured((current) => {
        if (width <= 0 || height <= 0) return null
        if (!current) return { width, height }

        /**
         * `chapter-body` 的高度是 `fitBodyHeight` **自己写进去的**。把它当成「尺寸变了」
         * 再触发一次布局，就正好绕成 observer → state → 改高度 → observer 的环。
         * 这一格真正需要跟着重排的只有宽度（分隔条、视图模式、窗口变化）。
         * 1px 容差挡的是亚像素抖动。
         */
        if (content === 'chapter-body') {
          return Math.abs(current.width - width) < 1 ? current : { width, height }
        }

        return current.width === width && current.height === height ? current : { width, height }
      })

      // 高度按内容长的那一格连视图那一层也要盯：见上面那条 state 的说明
      if (content === 'chapter-body') setViewport(viewportHeightOf(container))
    })

    observer.observe(container)

    /**
     * 视图那一层也要观察：窗口变高时容器自己可能一点没变（高度是算出来的），那就只有
     * 它的变化能把这一次重算叫醒。
     */
    const viewportElement = content === 'chapter-body' ? scrollableAncestorOf(container) : null
    if (viewportElement) observer.observe(viewportElement)

    return () => observer.disconnect()
  }, [content])

  /**
   * 编辑器只建一次：容器量到非零尺寸之后建，**卸载时**才销毁。
   *
   * ## 为什么销毁不在这条 effect 的清理里
   *
   * 它的依赖里有 `measured`，而这一格的尺寸在每次切换视图模式时都会变一次
   * （全宽 / 半宽 / 隐藏）—— 清理跟着跑，就等于每次切模式都把编辑器拆掉重建：
   * 撤销历史与光标位置全丢，而且重建是异步的，拆与建之间那一段就是空白。
   * 测量值此后只用来重新布局（见上面那条 useLayoutEffect）。
   *
   * ## 为什么依赖里有 `tab.path`
   *
   * 为的是**取消**为上一篇启动的那次创建：标签页换人时清理先跑，迟到的结果据此丢弃，
   * 不会把一个属于上一篇的编辑器挂到当前这一格上。创建本身照旧会为新的那一篇重来
   * （此时 `editorRef` 还是空）。
   */
  useEffect(() => {
    const container = containerRef.current
    // 没有容器、还没有非零尺寸、或者已经建过：这一轮不建（尺寸之后的变化由
    // automaticLayout 接着管）
    if (!container || !measured || editorRef.current) return

    let cancelled = false

    monacoLoader()
      .init()
      .then((instance) => {
        if (cancelled || editorRef.current) return

        /**
         * 整篇那一份**总要建出来**。
         *
         * 保存（editor-save 读的正是它）与表单字段改元数据（chapter-metadata）拿的都是
         * 它，而表单模式下这一格绑的是另一份（只有正文的那一份）—— 不在这里建，整篇
         * 那一份在表单模式里就永远不存在，保存会以「没有 model」被拒。
         */
        const current = useEditorStore.getState().tabs.find((item) => item.path === tab.path)
        if (current) ensureModel(current)

        /**
         * model 与编辑器**同一步**落地（见组件头部的说明）。
         *
         * 查不到标签页时给 null：编辑器先空着，也不会显示一个自己建的空文档 ——
         * 那种空文档会让「还没有 model」看起来像「正文丢了」。
         */
        const model = current
          ? content === 'chapter-body'
            ? ensureBodyModel(current)
            : ensureModel(current)
          : null

        const editor = instance.editor.create(container, {
          model,
          ...(content === 'chapter-body' ? CHAPTER_BODY_EDITOR_OPTIONS : DOCUMENT_EDITOR_OPTIONS)
        })

        editor.onDidChangeModelContent(() => {
          if (syncing.current) return

          const model = editor.getModel()
          if (!model) return

          /**
           * 模型值变了，把新正文交给 store。
           *
           * 路径由注册表给（`pathOfModel` / `pathOfBodyModel`），**不是** `model.uri.path`：
           * 后者在 Windows 上是 `/c:/a/b.md` 这种写法，而标签页的路径是主进程给的
           * `C:\a\b.md`（见 model-registry 里那两张对应表的说明）。
           */
          const changed = pathOfModel(model) ?? pathOfBodyModel(model)
          if (!changed) return

          /**
           * 表单模式改的是**正文那一份**，文件里的正文只有一处来源 —— 所以这一份要接回
           * 整篇（frontmatter 原样不动，见 editor/chapter-body.ts），保存读的才是新正文。
           */
          if (content === 'chapter-body') {
            applyChapterBody(changed, model.getValue(), syncing)
            return
          }

          useEditorStore.getState().setDocument(changed, model.getValue())
        })

        /**
         * 按内容长的那一格：内容变了就重算一次高度。
         *
         * 这是三条重算路径里最要紧的一条 —— 敲字、切标签页（换 model）、宿主机写入都会
         * 走到这里，而它们**都不改容器自己的尺寸**：没有它，换到一个短篇时那一格还撑着
         * 上一篇的高度，换到一个长篇时正文会被压在一条内部滚动的小窗口里。
         *
         * 视图高度在真正重算那一刻现量（见 scheduleFitBody 里的 viewportHeightOf）：
         * 这条通知来自**内容**变化，而重算会改被观察元素的尺寸 —— 所以只把它排进下一帧，
         * 且同一帧只排一次，避免 layout 反过来又触发这条通知时在同一帧里绕圈。
         */
        if (content === 'chapter-body') {
          editor.onDidContentSizeChange(scheduleFitBody)
        }

        /**
         * Ctrl+S：焦点在编辑器里时由这条命令接住（Monaco 处理掉的键位不会再冒泡到
         * document，所以与 EditorTabs 里那条监听不会各存一次）。
         */
        editor.addCommand(instance.KeyMod.CtrlCmd | instance.KeyCode.KeyS, () => {
          void saveActiveTab()
        })

        editorRef.current = editor
        setReady(true)
      })
      /**
       * 明确接住失败并记一笔。
       *
       * 少了这一段，`loader.init()` 拒绝时就是一个**没有任何上下文**的 unhandled
       * rejection（日志里只会看到 `{isTrusted: true}`），完全看不出是编辑器起不来。
       */
      .catch((err: unknown) => {
        logger.error('Failed to create the Monaco editor', { error: err })
      })

    // 只取消这一次创建，**不**销毁编辑器：销毁归下面那条 effect（见上面两段说明）
    return () => {
      cancelled = true
    }
  }, [measured, tab.path, syncing, content, scheduleFitBody])

  /**
   * 卸载时销毁编辑器。
   *
   * 刻意与上面那条创建 effect 分开，并且声明在它**之后**：卸载时 React 按声明顺序跑
   * 清理，于是「取消创建」先于「销毁实例」。反过来的话，一次还在路上的创建会在实例
   * 已被销毁之后才把编辑器建出来，而那个编辑器没有任何人会释放。
   *
   * model 不归编辑器管（它由 model-registry 管理，见那里的说明），这里只销毁实例。
   */
  useEffect(
    () => () => {
      editorRef.current?.dispose()
      editorRef.current = null
    },
    []
  )

  /** 切标签页：换成那个标签页的 model（撤销历史、光标、滚动位置都在 model 上） */
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    const current = useEditorStore.getState().tabs.find((item) => item.path === tab.path)

    if (!current) {
      editor.setModel(null)
      return
    }

    /**
     * 表单模式里还要顺手把**整篇那一份**建出来：切到这一篇之后，保存与表单字段用的是
     * 它，而这一格里没有别的组件会去建（与上面创建 effect 里同一句话）。
     */
    if (content === 'chapter-body') ensureModel(current)

    const model = content === 'chapter-body' ? ensureBodyModel(current) : ensureModel(current)
    if (editor.getModel() !== model) editor.setModel(model)
  }, [tab.path, ready, content])

  /**
   * 宿主写入。
   *
   * 写入期间把 `syncing` 置起来，`onDidChangeModelContent` 据此跳过这次通知 ——
   * 否则「写入 -> 通知 -> 又当成用户编辑 -> 再写回」会绕成环。
   *
   * 表单模式里这一格有**两份**内容要对齐：整篇那一份（保存与表单字段读它）与正文那一份
   * （屏幕上这一份）。前者按 store 里那一篇对（表单字段改元数据、宿主重新读盘都走它），
   * 后者按**整篇那一份**里摘出来的正文对 —— 见下面那句说明。
   */
  useEffect(() => {
    if (!ready) return

    const file = modelFor(tab.path)
    if (file && file.getValue() !== tab.content) {
      writeModelSilently(file, tab.content, syncing)
    }

    if (content !== 'chapter-body') return

    const body = bodyModelFor(tab.path)
    if (!body) return

    /**
     * 正文那一份对的是**整篇那一份 model**，不是 store 里那个副本。
     *
     * 整篇那一份是每一次按键都同步写过的那一份（见 editor/chapter-body.ts），比 store
     * 里推过来的副本新；拿副本对账会把用户刚敲下的那一下退回去 —— 一帧里落下两次编辑
     * 时就会出现（这一条 effect 拿到的 `tab.content` 是那一帧渲染时的值）。
     */
    const text = chapterBodyOf(file ? file.getValue() : tab.content)
    if (body.getValue() !== text) writeModelSilently(body, text, syncing)
  }, [tab.content, tab.path, ready, syncing, content])

  return (
    <div
      ref={containerRef}
      // 「编辑器走到哪一步」写在 DOM 上：它画在 React 之外，没有这一句就查不出为什么是空的
      data-nide-editor={ready ? 'ready' : 'pending'}
      className={className}
    />
  )
}
