import { type ComponentType, type JSX } from 'react'
import { ExplorerView } from '@nide/client-ui-main/explorer/ExplorerView'
import { CommitView } from '@nide/client-ui-main/git/CommitView'
import { GitView } from '@nide/client-ui-main/git/GitView'
import { useViewChrome } from '@nide/client-ui-main/view/chrome-context'
import { ViewFrame } from '@nide/client-ui-main/view/ViewFrame'
import {
  HOST_COMMIT_VIEW_ID,
  HOST_EXPLORER_VIEW_ID,
  HOST_GIT_VIEW_ID
} from '@nide/contracts/plugin-api'

/**
 * 宿主**内建**视图的组件表：视图 id -> 组件。
 *
 * 插件视图靠 Vite 在构建期把磁盘上的模块 glob 进来（见 PluginSlot）；内建视图
 * 的组件本来就在宿主的模块图里，直接静态 import 即可 —— 走 glob 那一套反而要
 * 先把它们搬到 plugins/ 目录下，假装成插件。
 *
 * 组件表是**编译期**的：`HOST_VIEWS`（主进程那一侧）声明了哪些内建视图存在，
 * 这里必须给出同名的组件。少一条就是「按钮在、内容区空着」，所以两处都放在
 * 常量旁边，改动时不容易漏。目前三项：文件树、版本控制、提交。
 */
const HOST_VIEW_COMPONENTS: Record<string, ComponentType> = {
  [HOST_EXPLORER_VIEW_ID]: ExplorerView,
  [HOST_GIT_VIEW_ID]: GitView,
  [HOST_COMMIT_VIEW_ID]: CommitView
}

/**
 * 渲染一个内建视图。
 *
 * 认不出的 id 会显示一句说明而不是空白：那说明主进程声明了一个渲染进程没有
 * 实现的视图，是**两处清单不同步**的 bug，让它显眼。那一句也走通用外壳，
 * 否则这一块会连标题栏一起消失，看起来像整个工具区坏了。
 */
export function HostSlot({ viewId }: { viewId: string }): JSX.Element {
  const Component = HOST_VIEW_COMPONENTS[viewId]

  if (!Component) return <HostNotice viewId={viewId} />

  return <Component />
}

/** 内建视图清单不同步时的说明页 */
function HostNotice({ viewId }: { viewId: string }): JSX.Element {
  const chrome = useViewChrome()

  return (
    <ViewFrame chrome={chrome}>
      <pre className="h-full overflow-auto p-3 font-mono text-[11px] leading-4 whitespace-pre-wrap text-red-400">
        {`宿主没有实现内建视图 ${viewId}。\n主进程的 HOST_VIEWS 与渲染进程的 ` +
          'HOST_VIEW_COMPONENTS 必须一一对应。'}
      </pre>
    </ViewFrame>
  )
}
