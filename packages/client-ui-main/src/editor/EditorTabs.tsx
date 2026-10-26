import { JSX, useEffect, useRef } from 'react'
import { DocumentViewModes } from '@nide/client-ui-main/editor/DocumentViewModes'
import { EditorPanes } from '@nide/client-ui-main/editor/EditorPanes'
import {
  documentViewInputOf,
  documentViewOf,
  resolveDocumentMode
} from '@nide/client-ui-main/editor/document-mode'
import { useEditorChrome } from '@nide/client-ui-main/editor/editor-chrome'
import { saveActiveTab, saveTab } from '@nide/client-ui-main/editor/editor-save'
import { releaseClosedModels } from '@nide/client-ui-main/editor/model-registry'
import { UnsavedCloseDialog } from '@nide/client-ui-main/editor/UnsavedCloseDialog'
import { ViewFrame } from '@nide/client-ui-main/view/ViewFrame'
import { useDocumentViewStore } from '@nide/client-kit/stores/document-view.store'
import { getT, useT } from '@nide/client-kit/stores/i18n.store'
import { useEditorStore } from '@nide/client-kit/stores/editor.store'
import { type FileWriteFailureReason } from '@shared/project'
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
 * 历史、光标与滚动位置。正文只有一个副本，就在 model 里。
 *
 * ## 正文与 store 的关系
 *
 * store 存 `originalValue`（磁盘上的原样）、`content`（当前正文的副本）与由它们算出的
 * `dirty`。副本是给**正文之外的消费者**用的：章节表单与 Markdown 预览都要按正文渲染，
 * 而它们不该为此拿到一个编辑器实例（见 stores/editor.store 里那段说明）。
 *
 * ## 视图模式
 *
 * 有几种看法的文件在标题栏上多出一组按钮：Markdown 是「纯文本 / 拆分 / 预览」（章节还
 * 多一个表单），图鉴的 yml 是「纯文本 / 表单」。正文的排布随之变化（见 EditorPanes）。
 *
 * 分类、可用模式与默认值都在 document-mode.ts 里，**这一层把它算成一份结论**再交给
 * 工具栏与正文那两层：三处各判一次迟早会分叉，而分叉的表现是「按钮说能填表单、正文却
 * 给了一段纯文本」。
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
 * 落在输入框里时**不抢** Ctrl+S：那时用户正在起名字（新建 / 重命名对话框）、正在填
 * 章节表单，或者正在回答一个浮层里的话 —— 而把这一下当成「保存当前标签页」的后果是
 * 悄悄写了一次盘。保存是显式动作，不该从别的地方顺手发生。编辑器自己那一份由 Monaco
 * 的命令接管（见 EditorPanes 里的 MonacoHost），所以排除了它也不会少一条路。
 */
function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element || typeof element.tagName !== 'string') return false

  const tag = element.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || element.isContentEditable
}

export function EditorTabs(): JSX.Element {
  const tabs = useEditorStore((s) => s.tabs)
  /**
   * 当前标签页。
   *
   * 这个组件本身不拿它换 model（那是正文那一层的事），但**必须订阅**：标题栏上的
   * 标题、视图模式按钮、以及正文按哪一种模式渲染，全都跟着活跃标签页走。
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

  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null

  /**
   * 这一篇能怎么看：有哪几种看法、默认停在哪一种、现在在哪一种。
   *
   * 结论只算一处（见 document-mode.ts），工具栏与正文那一层拿到的是**同一份** —— 少了
   * 这一点就会出现「按钮有表单、正文给纯文本」这类只有对照两处才看得出来的分叉。
   */
  const view = activeTab === null ? null : documentViewOf(documentViewInputOf(activeTab))
  const selectedMode = useDocumentViewStore((s) => (activePath ? s.modes[activePath] : undefined))
  const mode = view === null ? null : resolveDocumentMode(selectedMode, view)

  /**
   * 「这一帧往 model 里写的值，是宿主写的不算用户编辑」。
   *
   * 与正文那一层共用同一个对象（见 EditorPanes 里的说明）：它是渲染循环里的即时状态，
   * 不是界面数据，所以用 ref 而不是 state。
   */
  const syncingRef = useRef(false)

  /**
   * 标题栏上那一组视图按钮。
   *
   * 没有可切换的看法时**一个按钮都不画**（纯文本文件、不认识的 yml）：一组点了没反应
   * 的按钮不如不画。判据就是 `modes` 是不是空的 —— 这一层不再自己判断「是不是 Markdown」。
   */
  const toolbar =
    activeTab !== null && view !== null && mode !== null && view.modes.length > 0 ? (
      <DocumentViewModes
        // key 绑路径：换一篇时这一组按钮重新挂载，免得把上一篇的展开状态带过去
        key={activeTab.path}
        path={activeTab.path}
        modes={view.modes}
        mode={mode}
      />
    ) : null

  /**
   * 标签页的展示数据 + 外壳配置，外加标题栏上的视图模式按钮。
   *
   * 主编辑区不在任何工具区里（没有视图描述），所以它自己就是那个视图：外壳由它
   * 交给 ViewFrame，与六个工具区里那些视图走的是同一个组件。
   */
  const chrome = useEditorChrome(activePath)

  // 关掉的标签页要连它的 model 与视图模式一起释放，否则改一次文件、关一次，会一直攒着
  useEffect(() => {
    const open = new Set(tabs.map((tab) => tab.path))

    releaseClosedModels(open)
    useDocumentViewStore.getState().forget(open)
  }, [tabs])

  /**
   * Ctrl+S / ⌘S。
   *
   * 焦点在编辑器里时由 Monaco 的命令接住（见 EditorPanes 的 MonacoHost），这里补的是
   * **其余地方**—— 文件树、标签条、工具区。监听挂在 document 上而不是某个容器上：这些
   * 地方的焦点落点五花八门，而「保存」是窗口级的一个动作。
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
    <ViewFrame chrome={chrome} slots={{ actions: toolbar }}>
      {activeTab === null ? (
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
      ) : view !== null && mode !== null ? (
        /**
         * 正文一律走 EditorPanes：**包括**没有预览、没有表单的纯文本文件。
         *
         * 那一类只有「纯文本」一种模式（见 document-mode.ts），排布与改动前的
         * `MonacoPane` 完全一样（弹性列里的 `flex-1`）。不另开一个组件，是因为两个
         * 组件各持一个 Monaco 实例、而 `loader.init()` 是异步的 —— 在两类标签页之间
         * 来回切时，先卸载的那一个可能在被拆掉之后才把实例建出来。
         *
         * `view` 与 `mode` 由这里传下去：结论只算一处（见上面的 view），而正文那一层
         * 按同一份决定画哪一种表单。
         */
        <EditorPanes tab={activeTab} view={view} mode={mode} syncing={syncingRef} />
      ) : null}

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
