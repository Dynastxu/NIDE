import { createContext, useContext } from 'react'
import type { PluginViewDescriptor } from '@nide/contracts/plugin-api'

/**
 * 「我现在画的是哪个视图」的上下文。
 *
 * 外壳上的几处需要知道视图是谁：标题前面的图标取自视图声明的 icon，最小化按钮朝
 * 哪个方向收起取自它的 location，静态开关取自 manifest 的 `chrome` —— 这些都在
 * 视图描述里，而外壳是**宿主**画的组件。
 *
 * 由承载视图的那一块（工具区）放进树里：视图描述来自主进程，插件自己拿不到它，
 * 而插件视图的组件代码里要用 `useViewChrome()` 取那份外壳配置（见 chrome-context）。
 *
 * 这里只放 context 与读它的 hook，Provider 由承载方直接写（`<ViewDescriptorContext.Provider>`）：
 * 一个只包一层 Provider 的组件不值得单独存在，而 React 的 Fast Refresh 又要求
 * 「只导出组件的文件里别夹带 hook」，两边凑在一起反而更绕。
 */
export const ViewDescriptorContext = createContext<PluginViewDescriptor | null>(null)

/**
 * 读当前视图的描述。
 *
 * 返回 null 不算错误：视图被独立渲染（单测、插件预览）时本来就没有描述，
 * 外壳与 hook 那时退回到「没有图标、不能最小化、开关全用默认值」的画法。
 */
export function useViewDescriptor(): PluginViewDescriptor | null {
  return useContext(ViewDescriptorContext)
}
