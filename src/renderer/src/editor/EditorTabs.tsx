import { JSX, useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import loader from '@monaco-editor/loader'
import { useEditorChrome } from '@renderer/editor/editor-chrome'
import { saveActiveTab, saveTab } from '@renderer/editor/editor-save'
import {
  ensureModel,
  modelFor,
  pathOfModel,
  releaseClosedModels,
  writeModelSilently
} from '@renderer/editor/model-registry'
import { UnsavedCloseDialog } from '@renderer/editor/UnsavedCloseDialog'
import { ViewFrame } from '@renderer/view/ViewFrame'
import { getT, useT } from '@renderer/stores/i18n.store'
import { useEditorStore } from '@renderer/stores/editor.store'
import { baseNameOf, languageForPath, type FileWriteFailureReason } from '@shared/project'
import type { HostMessageKey } from '@shared/i18n'

/**
 * 工作台中间的主编辑区：上面一条标签页（由通用视图外壳画），下面一个 Monaco 实例。
 *
 * 标签页**不是**自己画的一行 —— 它走的是 `ViewFrame` 那套通用外壳：同一份标签页
 * 数据结构（ViewTab）、同一个关闭按钮、同一个「更多」菜单。中间这一块与六个工具区
 * 因此长得一样，能力也一样（可关闭的标签、×/圆点两种关闭按钮、标签上的自定义按钮）。
 * 这里只把编辑器的业务状态翻译成外壳要的展示数据（见 editor-chrome.ts）。
 *
 * ## 没有打开任何文件时不建编辑器
 *
 * Monaco 的初始化不便宜（加载、建 DOM、挂事件）。一个文件都没打开时不渲染它，
 * 只显示一句「在左侧点一个文件」—— 首屏也因此不必为一个空编辑器付代价。
 * 代价是编辑器组件会随标签页从 0 到 1、再从 1 到 0 挂载和卸载，所以 model
 * 不能挂在组件内部（见 model-registry.ts）。
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
 * 三条入口共用同一个函数（见 editor-save.ts）：编辑器里的 Ctrl+S、标题栏文件菜单的
 * 「保存」、以及关掉一个改过的标签页时那一问的「保存」。这里负责前两条中的第一条
 * —— 键位属于编辑器这一层，而动作本身不在这里。
 *
 * ## 关掉一个改过的标签页
 *
 * 关闭是**两步**的：没有未落盘改动就直接关，有改动的先问一句（保存 / 不保存 /
 * 取消）。要问哪一问由 store 的关闭队列说了算（见 stores/editor.store），这一层
 * 只把队首画成 `UnsavedCloseDialog`，并把用户的回答交给保存与收尾那两步。
 * 放在这里而不是外壳里，是因为那一问要用到 model（保存要读正文）—— 那是编辑器
 * 这一层才知道的事，通用外壳不该认识它。
 */

/** 保存失败的原因 -> 词条 key。与读取失败那一张表分开：要做的事不一样 */
const SAVE_FAILURE_KEYS: Record<FileWriteFailureReason, HostMessageKey> = {
  'invalid-path': 'host.editor.save.failed.invalid-path',
  'outside-project': 'host.editor.save.failed.outside-project',
  'not-text': 'host.editor.save.failed.not-text',
  'not-a-file': 'host.editor.save.failed.not-a-file',
  'too-large': 'host.editor.save.failed.too-large',
  unreadable: 'host.editor.save.failed.unreadable'
}

/**
 * 这一下键盘事件落在能打字的地方吗。
 *
 * 落在输入框里时**不抢** Ctrl+S：那时用户正在起名字（新建 / 重命名对话框）或者正在
 * 回答一个浮层里的话，而把这一下当成「保存当前标签页」的后果是悄悄写了一次盘 ——
 * 保存是显式动作，不该从别的地方顺手发生。编辑器自己那一份由 Monaco 的命令接管
 * （见 MonacoPane），所以排除了它也不会少一条路。
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || typeof element.tagName !== 'string') return false

  const tag = element.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || element.isContentEditable
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

  const model = ensureModel(tab)
  if (editor.getModel() !== model) editor.setModel(model)
}

export function EditorTabs(): JSX.Element {
  const tabs = useEditorStore((s) => s.tabs)
  /**
   * 当前标签页。
   *
   * 这个组件本身不拿它换 model（那是 MonacoPane 的事），但**必须订阅**：标题栏上的
   * 标题与高亮都跟着活跃标签页走，而订阅点就是这里。
   */
  const activePath = useEditorStore((s) => s.activePath)
  /**
   * 等着用户回答「保存吗」的那些标签页。
   *
   * 队首那个就是要画出来的那一问（见 stores/editor.store 的 drainCloseQueue）：
   * 一次关多个时，要问的会一个一个问过来，而不是同时摆出几个浮层。
   */
  const closeQueue = useEditorStore((s) => s.closeQueue)
  const t = useT()

  /**
   * 标签页的展示数据 + 外壳配置。
   *
   * 主编辑区不在任何工具区里（没有视图描述），所以它自己就是那个视图：外壳由它
   * 交给 ViewFrame，与六个工具区里那些视图走的是同一个组件。
   *
   * `activePath` 在上面订阅、在这里经 hook 使用：标题栏上的标题与高亮都跟着活跃
   * 标签页走，而这个组件是这一块唯一的订阅点（换 model 那件事归 MonacoPane，
   * 它只管正文）。
   */
  const chrome = useEditorChrome(activePath)

  // 关掉的标签页要连它的 model 一起释放，否则改一次文件、关一次，model 会一直攒着
  useEffect(() => {
    releaseClosedModels(new Set(tabs.map((tab) => tab.path)))
  }, [tabs])

  /**
   * Ctrl+S / ⌘S。
   *
   * 焦点在编辑器里时由 Monaco 的命令接住（见 MonacoPane），这里补的是**其余地方**
   * —— 文件树、标签条、工具区。监听挂在 document 上而不是某个容器上：这些地方的
   * 焦点落点五花八门，而「保存」是窗口级的一个动作。
   *
   * 没有改动时 saveActiveTab 什么都不做（见 editor-save.ts）：一次写入会换掉文件的
   * inode 与 mtime，没有理由为一次空按付那个代价。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // 带上 Alt / Shift 的那几组不是「保存」：Ctrl+Shift+S 是「另存为」的习惯键位，
      // 而宿主没有另存为 —— 把它当保存吃掉，比什么都不做更让人意外
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key !== 's' && event.key !== 'S') return
      if (isTypingTarget(event.target)) return

      event.preventDefault()
      void saveActiveTab()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const pendingPath = closeQueue[0] ?? null
  const pendingTab = pendingPath ? (tabs.find((tab) => tab.path === pendingPath) ?? null) : null

  return (
    <ViewFrame chrome={chrome}>
      {tabs.length > 0 ? (
        <MonacoPane />
      ) : (
        /**
         * 空态：告诉用户文件从哪儿来。中间区域没有任何入口按钮，只能靠这两句。
         * 有标签页时标题栏已经写着当前文件，这里再重复一遍就是占地方。
         */
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-sm text-zinc-400">{t('host.editor.empty.title')}</p>
          <p className="max-w-sm text-xs leading-relaxed text-zinc-500">
            {t('host.editor.empty.hint')}
          </p>
        </div>
      )}

      {/*
        key 绑路径：换一个标签页来问时重新挂载，焦点与「上一次保存失败」那句话都跟着
        重来 —— 否则第二个标签页会带着第一个的错误提示出现。
      */}
      {pendingTab && (
        <UnsavedCloseDialog
          key={pendingTab.path}
          name={pendingTab.name}
          onSave={async () => {
            const result = await saveTab(pendingTab.path)
            if (!result.ok) return getT()(SAVE_FAILURE_KEYS[result.reason])

            // 写盘成功了，把它从队列里摘掉，继续处理后面那些（可能还有要问的）
            useEditorStore.getState().finishClose()
            return null
          }}
          onDiscard={() => useEditorStore.getState().finishClose()}
          onCancel={() => useEditorStore.getState().cancelClose()}
        />
      )}
    </ViewFrame>
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
         * 路径由注册表给（`pathOfModel`），**不是** `model.uri.path`：后者在 Windows 上
         * 是 `/c:/a/b.md` 这种写法，store 里认的却是主进程给的 `C:\a\b.md`，拿它去查
         * 标签页永远查不到（见 model-registry 里那张对应表的说明）。
         *
         * 另外，切 model 本身不会触发本事件 —— Monaco 只在**内容**变化时触发 ——
         * 所以这里不必判断这条通知来自哪个 model。
         */
        const path = pathOfModel(model)
        if (!path) return

        useEditorStore.getState().setContent(path, model.getValue())
      })

      /**
       * Ctrl+S：焦点在编辑器里时由这条命令接住（Monaco 处理掉的键位不会再冒泡到
       * document，所以与 EditorTabs 里那条监听不会各存一次）。
       */
      editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.KeyS, () => {
        void saveActiveTab()
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
      // model 不归编辑器管，它由 model-registry 管理，这里不碰
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
   * 场景：用户改了第 3 章（圆点亮了），于是再点一次文件树里的它 —— store 那边
   * `originalValue` 已经换成磁盘内容、dirty 清成 false，但 model 里还是改过的正文。
   * 不同步的话，圆点说的和正文写的就对不上了。
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

    const model = modelFor(tab.path)
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

      const model = modelFor(filePath)
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
