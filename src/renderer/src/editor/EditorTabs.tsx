import { JSX, useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import loader from '@monaco-editor/loader'
import { EditorTabBar } from '@renderer/editor/TabBar'
import { useT } from '@renderer/stores/i18n.store'
import { useEditorStore } from '@renderer/stores/editor.store'
import { baseNameOf, languageForPath } from '@shared/project'

/**
 * 工作台中间的主编辑区：上面一条标签页，下面一个 Monaco 实例。
 *
 * ## 没有打开任何文件时不建编辑器
 *
 * Monaco 的初始化不便宜（加载、建 DOM、挂事件）。一个文件都没打开时不渲染它，
 * 只显示一句「在左侧点一个文件」—— 首屏也因此不必为一个空编辑器付代价。
 * 代价是编辑器组件会随标签页从 0 到 1、再从 1 到 0 挂载和卸载，所以 model
 * 不能挂在组件内部（见下面的 MODEL_CACHE）。
 *
 * ## 一个编辑器，多个 model
 *
 * 每个打开的文件对应**一个 Monaco model**（URI 就是文件路径）。切标签页做的是
 * `editor.setModel()`，不是销毁重建编辑器 —— 这样切换保留每个文件自己的撤销
 * 历史、光标与滚动位置，而且不必把「当前模型的内容」再同步回 store：
 * 正文只有一个副本，就在 model 里。
 *
 * ## 正文与 store 的关系
 *
 * store 只存 `originalValue`（磁盘上的原样）与一个 `dirty` 结论，正文本身不在
 * store 里。`onDidChangeModelContent` 负责把「与磁盘是否一致」的结论推回去。
 *
 * ## 保存
 *
 * 宿主没有实现保存：`readOnly` 是 false（宿主是写作工具，不让打字没有意义），
 * 但 Ctrl+S 不会写盘，标签页上的圆点只表示「这些改动还没落盘」。
 * 接入保存时落点就是这里 —— 读 model 的值、走一条新的 IPC、成功后把
 * `originalValue` 推到当前值。
 */

/**
 * 已建好的 model 缓存：`文件路径 -> model`。
 *
 * 放在**模块级**而不是 useRef 里，是因为编辑器组件会在标签页归零时卸载 ——
 * 挂在组件内部的缓存在那一刻就没了，而 model 是「打开过的文件」这个更长寿的
 * 概念的一部分。它的生命周期只跟随 store 里的 `tabs`：
 * 标签页被关掉时释放（见下面的清理 effect），窗口重建时随渲染进程一起消失。
 *
 * 同一时刻只有一个窗口能用到它：这个模块属于主窗口的渲染进程。
 */
const MODEL_CACHE = new Map<string, monaco.editor.ITextModel>()

/** 关掉标签页时释放它的 model，否则改一次文件、关一次，model 会一直攒着 */
function releaseClosedModels(openPaths: ReadonlySet<string>): void {
  for (const [path, model] of MODEL_CACHE) {
    if (openPaths.has(path)) continue
    model.dispose()
    MODEL_CACHE.delete(path)
  }
}

/**
 * 把一份内容写进 model，并且**不让这次写入被当成用户的编辑**。
 *
 * 用 `pushEditOperations` 而不是 `setValue`：前者保留撤销历史（宿主改过之后
 * 用户还能 Ctrl+Z 退回去），后者会把历史清空。
 *
 * `syncing` 是指向调用方那个 ref 的引用 —— 写入期间把它置成 true，
 * `onDidChangeModelContent` 据此跳过 setContent，否则「写入 -> 算 dirty ->
 * 又写回 store」会绕成环，把刚刚设好的基准立刻推翻。
 */
function writeModelSilently(
  model: monaco.editor.ITextModel,
  content: string,
  syncing: { current: boolean }
): void {
  syncing.current = true
  try {
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null)
  } finally {
    syncing.current = false
  }
}

/**
 * 把编辑器切到 store 里那个活跃标签页的 model。
 *
 * 有**两个**调用点，缺一个都会看到空编辑器：
 *
 * 1. 活跃路径变化时（切标签页）；
 * 2. 编辑器异步建好之后 —— 挂载那一刻 `loader.init()` 还没 resolve，
 *    第 1 条那时拿不到 editor。首次挂载因此永远走的是这一条。
 */
function applyActiveModel(editor: monaco.editor.IStandaloneCodeEditor): void {
  const { tabs, activePath } = useEditorStore.getState()
  const tab = tabs.find((item) => item.path === activePath)

  if (!tab) {
    editor.setModel(null)
    return
  }

  let model = MODEL_CACHE.get(tab.path)
  if (!model) {
    model = monaco.editor.createModel(tab.originalValue, tab.language, monaco.Uri.file(tab.path))
    MODEL_CACHE.set(tab.path, model)
  }

  if (editor.getModel() !== model) editor.setModel(model)
}

export function EditorTabs(): JSX.Element {
  const tabs = useEditorStore((s) => s.tabs)
  const t = useT()

  // 关掉的标签页要连它的 model 一起释放，否则改一次文件、关一次，model 会一直攒着
  useEffect(() => {
    releaseClosedModels(new Set(tabs.map((tab) => tab.path)))
  }, [tabs])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-zinc-900">
      <EditorTabBar />

      {tabs.length > 0 ? (
        <MonacoPane />
      ) : (
        // 空态：告诉用户文件从哪儿来。中间区域没有任何入口按钮，只能靠这句
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm text-zinc-400">{t('host.editor.empty.title')}</p>
          <p className="max-w-sm text-xs leading-relaxed text-zinc-500">
            {t('host.editor.empty.hint')}
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * Monaco 本体。
 *
 * 只在「有标签页」时挂载（见上面的说明）。编辑器实例只在挂载时建一次，
 * 切换标签页是换 model，不重建编辑器。
 */
function MonacoPane(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  /**
   * 上一次真正切过去的标签页。
   *
   * `tabs` 每敲一个字都会换一个新数组（dirty 在那时重算），如果只按 `tabs` 的
   * 变化抢焦点，就会出现「用户在左侧文件树里点别的目录，焦点被编辑器抢回来」。
   * 焦点只在**活跃路径真的变了**时才动。
   */
  const focusedPathRef = useRef<string | null>(null)
  /**
   * 上一次已经同步过的「标签页 + 重新打开次数」。
   *
   * 用 `路径#计数` 而不是只记路径：重新打开同一个文件会推进计数，那次必须再同步
   * 一次 model（见下面那条 effect）。
   */
  const refreshedRef = useRef<string | null>(null)
  /**
   * 正在由**宿主**写入 model 值。
   *
   * 用 ref 而不是 state：它是渲染循环里的即时状态，不是界面数据。没有它的话
   * 「写入 -> 触发 change -> 写回 store -> 再渲染 -> 又写入」会绕成环。
   */
  const syncingRef = useRef(false)

  const tabs = useEditorStore((s) => s.tabs)
  const activePath = useEditorStore((s) => s.activePath)

  // 编辑器本体：挂载时建一次
  useEffect(() => {
    if (!containerRef.current) return

    loader.config({ monaco })
    let disposed = false

    loader.init().then((monacoInstance) => {
      if (disposed || !containerRef.current) return

      const editor = monacoInstance.editor.create(containerRef.current, {
        theme: 'vs-dark',
        minimap: { enabled: false },
        fontSize: 14,
        automaticLayout: true,
        // 小说稿是长文本：默认的 80 列参考线在这种文档里没有意义，而软换行必须开
        wordWrap: 'on',
        scrollBeyondLastLine: false
      })

      editor.onDidChangeModelContent(() => {
        if (syncingRef.current) return

        const model = editor.getModel()
        if (!model) return

        /**
         * 模型值变了，把「与磁盘是否一致」的结论推回 store。
         *
         * 依赖「切 model 不会触发本事件」这一点：Monaco 只在**内容**变化时触发，
         * setModel 本身不算。所以这里不必判断这条通知来自哪个 model。
         */
        useEditorStore.getState().setContent(model.uri.path, model.getValue())
      })

      editorRef.current = editor

      /**
       * 建好之后先看这一轮是不是已经被拆掉了。
       *
       * 在开发模式下 React 会刻意把 effect 跑两遍（挂载 -> 卸载 -> 再挂载），
       * 而 `loader.init()` 是异步的：第一次的清理可能已经跑完、`disposed` 已经是
       * true，它才 resolve。不在这里补一刀的话，第一次建出来的编辑器会留在容器
       * 里没人持有，也永远不会被释放（DOM 里叠着两层编辑器）。
       */
      if (disposed) {
        editor.dispose()
        editorRef.current = null
        return
      }

      applyActiveModel(editor)
      // 编辑器是刚建出来的，此刻焦点还在别处（多半是左侧文件树），拉过来是应符合预期
      editor.focus()
      focusedPathRef.current = useEditorStore.getState().activePath
    })

    return () => {
      disposed = true
      editorRef.current?.dispose()
      editorRef.current = null
      // model 不归编辑器管，它由 EditorTabs 的缓存管理，这里不碰
    }
  }, [])

  // 活跃标签页换人（首次挂载由建好编辑器那一侧负责，见 applyActiveModel）
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return

    applyActiveModel(editor)

    if (focusedPathRef.current === activePath) return
    focusedPathRef.current = activePath
    editor.focus()
  }, [activePath, tabs])

  /**
   * 重新打开一个**改动还没落盘**的文件时，把它的 model 拉回磁盘上的版本。
   *
   * 场景：用户改了第 3 章（圆点亮了），没有保存功能，于是再点一次文件树里的它 ——
   * store 那边 `originalValue` 已经换成磁盘内容、dirty 清成 false，但 model 里
   * 还是改过的正文。不同步的话，圆点说的和正文写的就对不上了。
   *
   * 触发条件是 `refreshToken`（只由 openFile 命中已开标签页时推进），**不是**
   * 「model 与 originalValue 不同」—— 后者在用户打字时也成立，那样每敲一个字符
   * 就会被回退一次（见 EditorTab.refreshToken 的说明）。
   */
  useEffect(() => {
    const state = useEditorStore.getState()
    const tab = state.tabs.find((item) => item.path === state.activePath)
    if (!tab || !activePath) return

    const key = `${tab.path}#${tab.refreshToken}`
    if (refreshedRef.current === key) return
    refreshedRef.current = key

    // refreshToken 为 0 表示这个标签页是刚建的，model 本来就照它建，不必再写
    if (tab.refreshToken === 0) return

    const model = MODEL_CACHE.get(tab.path)
    if (!model || model.getValue() === tab.originalValue) return

    writeModelSilently(model, tab.originalValue, syncingRef)
  }, [activePath, tabs])

  // 宿主推来新内容（AI 插件写入之后）：覆盖对应 model，并让它成为「与磁盘一致」
  useEffect(() => {
    const subscription = window.hostAPI.onFileChanged((filePath, content) => {
      const state = useEditorStore.getState()

      /**
       * 把磁盘上的新内容记成新基准。
       *
       * 走 syncFromDisk 而不是 openFile：后者会把 activePath 切到这个文件，于是
       * AI 改写一个后台文件就会把用户的视图抢走 —— 他可能正看着另一章。
       * 没开着的文件才 fallback 到 openFile（打开它本来就是这次通知想做的事）。
       */
      if (!state.syncFromDisk(filePath, content)) {
        state.openFile({
          path: filePath,
          name: baseNameOf(filePath),
          language: languageForPath(filePath),
          content
        })
      }

      const model = MODEL_CACHE.get(filePath)
      if (!model || model.getValue() === content) return

      writeModelSilently(model, content, syncingRef)
    })

    return () => subscription.dispose()
  }, [])

  // Diff 展示请求（AI 提议修改）：与标签页无关，浮层自己处理
  useEffect(() => {
    const subscription = window.hostAPI.onShowDiff((original, modified) => {
      useEditorStore.getState().showDiff(original, modified)
    })
    return () => subscription.dispose()
  }, [])

  return <div ref={containerRef} className="min-h-0 flex-1" />
}
