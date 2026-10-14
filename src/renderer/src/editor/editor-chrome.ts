import { useMemo } from 'react'
import { saveActiveTab } from '@renderer/editor/editor-save'
import { useT } from '@renderer/stores/i18n.store'
import { useEditorStore } from '@renderer/stores/editor.store'
import { useViewChrome, type ViewChromeConfig } from '@renderer/view/chrome-context'
import type { ViewMoreItem, ViewTab } from '@shared/plugin-api'

/**
 * 把主编辑区的文件标签页接到视图外壳上。
 *
 * 中间这一块与其他六个工具区走的是**同一套外壳**（见 view/ViewFrame）：标签页、
 * 关闭按钮、右上角的「更多」都由那一层画。这里只做翻译 ——
 * `editor.store` 的 `EditorTab` 与外壳要的 `ViewTab` 是两件事：
 *
 * | 外壳要的（纯展示）   | 编辑器有的（业务状态）           |
 * | -------------------- | -------------------------------- |
 * | label / title        | name / path                      |
 * | status（圆点）       | dirty（还没落盘）                |
 * | closable / closeIcon | 文件标签页永远可关，形状看 dirty |
 *
 * 刻意**不**把 `EditorTab` 直接当 `ViewTab` 用：外壳不该知道 Monaco model、
 * refreshToken 这些概念，而编辑器也不该知道关闭按钮画成什么形状。
 *
 * 三处刻意的差别，都由「它在'主'区」这一条推出：
 *
 * - **一个文件都没打开时整条标题栏不画**：那一块只有一句说明文字（见 EditorTabs），
 *   顶一条空标题栏等于白占一行高度，而那一行上没有任何信息；
 * - **藏着「最小化」**：主编辑区没有可收起的容器（它就是窗口里剩下的全部空间），
 *   一个点了什么都不发生的按钮比没有按钮更糟；
 * - **藏着「标题」**：当前文件名就写在它自己的标签页上（还是高亮的那一个），
 *   标题栏再重复一遍只是占掉标签条的宽度 —— 中间这一块要放的是「打开了哪些文件」。
 *
 * `activePath` 由调用方传进来，而不是在这个 hook 里再订阅一次：订阅点越少越清楚
 * （EditorTabs 那里有一处，并写明了为什么），这里只负责翻译。
 */
export function useEditorChrome(activePath: string | null): ViewChromeConfig {
  const t = useT()
  const tabs = useEditorStore((s) => s.tabs)
  const setActive = useEditorStore((s) => s.setActive)
  const requestClose = useEditorStore((s) => s.requestClose)

  const viewTabs = useMemo<ViewTab[]>(
    () =>
      tabs.map((tab) => ({
        id: tab.path,
        label: tab.name,
        // 文件名会被截断，完整路径是唯一能分辨同名文件的地方
        title: tab.path,
        closable: true,
        /**
         * 有未落盘的改动时，关闭按钮那一格画成圆点（表示状态），悬停才变回叉号。
         * 这样「这个文件改过」和「点它关掉」共用同一格宽度，标签条不必为两者各占一列。
         */
        closeIcon: tab.dirty ? 'dot' : 'close',
        status: tab.dirty ? 'dot' : 'none'
      })),
    [tabs]
  )

  const moreItems = useMemo<ViewMoreItem[]>(() => {
    if (tabs.length === 0) return []

    const activeDirty = tabs.find((tab) => tab.path === activePath)?.dirty ?? false

    return [
      {
        id: 'save',
        label: t('host.editor.save'),
        /**
         * 没有改动时置灰：那时写下去的就是磁盘上已有的那一份，一个注定什么都不改的
         * 入口不如直接说明为什么按不动（与「关闭未改动的」那一条同一条理由）。
         */
        disabled: !activeDirty,
        disabledReason: t('host.menu.file.save.disabled'),
        onSelect: () => void saveActiveTab()
      },
      {
        id: 'close-others',
        label: t('host.editor.menu.closeOthers'),
        disabled: tabs.length < 2,
        disabledReason: t('host.editor.menu.closeOthers.disabled'),
        onSelect: () => useEditorStore.getState().requestCloseOthers()
      },
      {
        id: 'close-saved',
        label: t('host.editor.menu.closeSaved'),
        // 一个文件都没落盘时它什么都关不掉 —— 不给一个注定空转的入口
        disabled: !tabs.some((tab) => !tab.dirty),
        disabledReason: t('host.editor.menu.closeSaved.disabled'),
        onSelect: () => useEditorStore.getState().requestCloseSaved()
      },
      {
        id: 'close-all',
        label: t('host.editor.menu.closeAll'),
        onSelect: () => useEditorStore.getState().requestCloseAll()
      }
    ]
  }, [tabs, t, activePath])

  return useViewChrome({
    tabs: viewTabs,
    activeTabId: activePath,
    moreItems,
    controller: { selectTab: setActive, closeTab: requestClose },
    /**
     * 三条运行期规则，合起来就是「主编辑区没有内容时不该有一条标题栏」：
     *
     * - **没有打开任何文件时整条标题栏都不画**：空态只有一句说明文字（见 EditorTabs），
     *   顶一条空标题栏等于白占一行高度，而且那行上什么信息都没有；
     * - **标题不显示**：当前文件名就写在它自己的标签页上（还是高亮的那一个），
     *   这里再说一遍只会把标签条挤窄 —— 视图描述里那份「编辑器」同理，根本不出现；
     * - **最小化不显示**：主编辑区没有可收起的容器（它就是窗口里剩下的全部空间），
     *   一个点了什么都不发生的按钮比没有按钮更糟。
     */
    configure: {
      showHeader: tabs.length > 0,
      showTitle: false,
      showMinimize: false,
      tabsClosable: true,
      closeIcon: 'close'
    }
  })
}
