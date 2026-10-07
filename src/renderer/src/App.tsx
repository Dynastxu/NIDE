import { MonacoEditor } from './editor/MonacoEditor'
import { MonacoDiffView } from './editor/MonacoDiffView'
import { PluginContainer } from './plugins/PluginContainer'
import { JSX } from 'react'

export default function App(): JSX.Element {
  return (
    <div className="flex h-screen w-screen bg-zinc-900 text-zinc-200 overflow-hidden">
      {/* 主编辑区 */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 min-h-0">
          <MonacoEditor />
        </div>
        {/* 底部面板：插件在这里注册自己的视图 */}
        <div className="h-48 border-t border-zinc-800">
          <PluginContainer location="panel" />
        </div>
      </div>

      {/* 右侧侧边栏：AI 对话等插件挂在这里 */}
      <div className="w-80 border-l border-zinc-800 flex flex-col">
        <PluginContainer location="sidebar" />
      </div>

      {/* Diff 弹层 */}
      <MonacoDiffView />
    </div>
  )
}
