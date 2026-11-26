import { type JSX } from 'react'
import { Slot } from '@nide/client-ui-renderer'
import { useViewChrome } from '@nide/client-ui-renderer/view/chrome-context'
import { ViewFrame } from '@nide/client-ui-renderer/view/ViewFrame'
import { hostViewSlotName } from '@nide/contracts/plugin-api'

/**
 * 宿主**内建**视图的渲染入口：按视图 id 找功能包注册的 slot。
 *
 * 窗口包不再认识任何具体视图的组件：文件树由本包注册，版本控制 / 提交由
 * `@nide/client-ui-git` 注册，都挂在 `hostViewSlotName(id)` 上。插件视图仍走
 * `PluginSlot`（模块表 + bundle）。
 *
 * 这样「加一个内建视图」= 新包注册一个 slot + host 登记一条描述符，窗口的
 * 布局、按钮条、工具区都不用改。
 *
 * 认不出的 id 会显示一句说明而不是空白：那说明 host 声明了一个没有组件注册的
 * 视图（两处清单不同步），让它显眼。那一句也走通用外壳，否则这一块会连标题栏
 * 一起消失，看起来像整个工具区坏了。
 */
export function HostSlot({ viewId }: { viewId: string }): JSX.Element {
  return <Slot name={hostViewSlotName(viewId)} fallback={<HostNotice viewId={viewId} />} />
}

/** 内建视图清单不同步时的说明页 */
function HostNotice({ viewId }: { viewId: string }): JSX.Element {
  const chrome = useViewChrome()

  return (
    <ViewFrame chrome={chrome}>
      <pre className="h-full overflow-auto p-3 font-mono text-[11px] leading-4 whitespace-pre-wrap text-danger-fg">
        {`宿主没有实现内建视图 ${viewId}。\n主进程登记的视图与客户端注册的 slot ` +
          '必须一一对应。'}
      </pre>
    </ViewFrame>
  )
}
