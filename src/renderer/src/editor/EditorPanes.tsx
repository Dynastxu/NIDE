import { JSX, useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import { monacoLoader } from '@renderer/monaco-env'
import { ChapterForm } from '@renderer/editor/ChapterForm'
import { MarkdownPreview } from '@renderer/editor/MarkdownPreview'
import { applyChapterMetadata } from '@renderer/editor/chapter-metadata'
import {
  ensureModel,
  modelFor,
  pathOfModel,
  writeModelSilently
} from '@renderer/editor/model-registry'
import { saveActiveTab } from '@renderer/editor/editor-save'
import { loggerFor } from '@renderer/logger'
import { defaultDocumentMode } from '@renderer/editor/document-mode'
import { useDocumentViewStore } from '@renderer/stores/document-view.store'
import { useEditorStore, type EditorTab } from '@renderer/stores/editor.store'
import { splitFrontmatter } from '@shared/project'

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
 * ## 布局只有一条规则
 *
 * 正文那一格是**弹性列的直接子元素**（`flex-col` 里的 `flex-1`）—— 与改动前完全一样。
 * 它的高度由 flex 布局直接给出，编辑器量到的就是「剩下多少地方」。
 *
 * 刻意**不**用网格叠层：`grid` 的默认行轨道是 `auto`，而编辑器那一格的内容是 Monaco
 * 自己绝对定位出来的层、不贡献高度 —— 行会塌成 0，编辑器什么都画不出来。
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
 * 重建一次。这是**刻意接受**的代价：把同一个实例在两种布局之间搬来搬去，正是前面几版
 * 出错的地方（容器还没进文档就被建出来、或者永远等不到一次尺寸测量）。重建只影响撤销
 * 历史与光标位置，正文本身在 model 里、一个字都不会丢。
 */
export function EditorPanes({
  tab,
  syncing
}: {
  /** 当前标签页。它的语言、路径与元数据决定这一帧长什么样 */
  tab: EditorTab
  /** 「这次 model 写入是宿主发起的」标记，与 MonacoHost 共用同一个（见那里的说明） */
  syncing: { current: boolean }
}): JSX.Element {
  const selected = useDocumentViewStore((s) => s.modes[tab.path])
  const mode = selected ?? defaultDocumentMode(tab.language, tab.path, tab.metadata)

  if (mode === 'form') {
    /**
     * 表单那一格：元数据字段 + 正文编辑器，整块可滚，宽度铺满主视图。
     *
     * **编辑器与表单是并列的两个子元素**（不是一个嵌在另一个里面）：表单那一层用
     * `key` 绑着 frontmatter 原文（改一个字段就要重新挂载，见 ChapterForm 的说明），
     * 而挂载/卸载会连同子树里的编辑器一起拆掉 —— 那意味着在索引框里每敲一个字符，
     * Monaco 就被销毁重建一次。把编辑器放在它**外面**，这条重挂载路线就与编辑器无关了。
     *
     * 编辑器的高度用 `h-[60vh]`（视口比例）而不是 `flex-1`：它是一段很长的稿子，需要
     * 一块**实打实**的地方，而不是「字段排完之后剩多少算多少」—— 后者在字段多的章节上
     * 会把它压成一条缝。它是这一格里唯一有高度的东西，其余字段按内容排。
     */
    return (
      /**
       * 表单那一格：整块可滚，左右留白**只在这里给一次**。
       *
       * 表单字段与正文编辑器都是它的子元素，公共留白放在父级比在两处各写一遍好：
       * 后者迟早会分叉（事实上已经分叉过一次 —— 表单那一层掉了 `px-4`，编辑器还在，
       * 于是字段贴着窗口边缘、编辑器却有留白）。
       */
      <div className="nide-scrollbar flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-4 py-4">
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

        {/* 与表单同一档左右留白，编辑器本身铺满这一格的宽度 */}
        <div className="pt-4">
          <MonacoHost tab={tab} syncing={syncing} className="h-[60vh] w-full" />
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
 * ## 编辑器与它的 model 在同一步落地
 *
 * `monaco.editor.create` 不带 model 时会**自己建一个空 model**并视其为己有（monaco 里
 * 的 `_ownsModel`），于是编辑器在有人 `setModel` 之前显示的是**空文档**。而「谁来
 * setModel」如果是一条依赖 `ready` 的独立 effect，它有可能永远不跑：创建是异步的，
 * 创建前后那两句 `setReady`（先 false 再 true）很容易落进同一批更新里 —— 状态绕一圈
 * 回到原值，React 判定没有变化，那条 effect 便不再执行，编辑器就停在空 model 上。
 * 现象正是「切换视图模式之后正文偶尔一片空白」，而且它不报任何错。
 *
 * 所以 model 在创建的同一步就定下来（`ensureModel` + `create({ model })`），
 * 「切标签页换 model」那条 effect 只负责**换**，不负责补第一次。
 */
function MonacoHost({
  tab,
  syncing,
  className = 'h-full w-full'
}: {
  /** 当前标签页：路径决定用哪个 model，正文决定写什么 */
  tab: EditorTab
  /** 「这次写入是宿主发起的」标记，见下面那条写入 effect */
  syncing: { current: boolean }
  /** 这一格怎么排（尺寸/留白）。默认铺满父级 —— 正文那一格的用法 */
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
   * 尺寸变了要重新布局。
   *
   * `automaticLayout` 盯的是**窗口**尺寸，而这一格的宽度会随分隔条与视图模式变化
   * （全宽 / 半宽 / 隐藏）—— 那种变化它看不见，所以测量到新尺寸时主动量一次。
   *
   * 隐藏中（`measured` 为 null）不量：那时量到的是 0×0，对编辑器没有任何意义，
   * 而重新可见时这一次量尺寸会再跑一遍。
   */
  useLayoutEffect(() => {
    if (!measured) return
    editorRef.current?.layout()
  }, [measured])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver(() => {
      const { width, height } = container.getBoundingClientRect()

      // 尺寸没变时不重复写 state：否则每次布局都会绕成一轮重渲染
      setMeasured((current) =>
        width <= 0 || height <= 0
          ? null
          : current && current.width === width && current.height === height
            ? current
            : { width, height }
      )
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [])

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
         * model 与编辑器**同一步**落地（见组件头部的说明）。
         *
         * 查不到标签页时给 null：编辑器先空着，也不会显示一个自己建的空文档 ——
         * 那种空文档会让「还没有 model」看起来像「正文丢了」。
         */
        const current = useEditorStore.getState().tabs.find((item) => item.path === tab.path)
        const model = current ? ensureModel(current) : null

        const editor = instance.editor.create(container, {
          model,
          minimap: { enabled: false },
          fontSize: 14,
          automaticLayout: true,
          // 小说稿是长文本：默认的 80 列参考线在这种文档里没有意义，而软换行必须开
          wordWrap: 'on',
          scrollBeyondLastLine: false
        })

        editor.onDidChangeModelContent(() => {
          if (syncing.current) return

          const model = editor.getModel()
          if (!model) return

          /**
           * 模型值变了，把新正文交给 store。
           *
           * 路径由注册表给（`pathOfModel`），**不是** `model.uri.path`：后者在 Windows 上
           * 是 `/c:/a/b.md` 这种写法，而标签页的路径是主进程给的 `C:\a\b.md`（见
           * model-registry 里那张对应表的说明）。
           */
          const changed = pathOfModel(model)
          if (!changed) return

          useEditorStore.getState().setDocument(changed, model.getValue())
        })

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
  }, [measured, tab.path, syncing])

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

    const model = ensureModel(current)
    if (editor.getModel() !== model) editor.setModel(model)
  }, [tab.path, ready])

  /**
   * 宿主写入。
   *
   * 写入期间把 `syncing` 置起来，`onDidChangeModelContent` 据此跳过这次通知 ——
   * 否则「写入 -> 通知 -> 又当成用户编辑 -> 再写回」会绕成环。
   */
  useEffect(() => {
    if (!ready) return

    const model = modelFor(tab.path)
    if (!model || model.getValue() === tab.content) return

    writeModelSilently(model, tab.content, syncing)
  }, [tab.content, tab.path, ready, syncing])

  return (
    <div
      ref={containerRef}
      // 「编辑器走到哪一步」写在 DOM 上：它画在 React 之外，没有这一句就查不出为什么是空的
      data-nide-editor={ready ? 'ready' : 'pending'}
      className={className}
    />
  )
}
