import { useEffect, useState, type JSX } from 'react'
import { useViewChrome } from '@renderer/view/chrome-context'
import { ViewFrame } from '@renderer/view/ViewFrame'

/**
 * 插件宿主自检：往主进程发一条事件，看它经由 `host:event` 原样回显。
 *
 * 它同时是**视图外壳最小用法**的样例：不声明标签页、不挂自己的按钮，只在标题栏的
 * 「更多」里放一个「清空」。宿主因此画出标题栏、标题、更多与最小化按钮。
 */
export default function DemoView(): JSX.Element {
  const [lines, setLines] = useState<string[]>([])
  const [text, setText] = useState('')

  useEffect(() => {
    const d = window.hostAPI.onEvent('echo:demo.ping', (...args: unknown[]) => {
      setLines((prev) => [...prev, `← 主进程回显: ${args.join(' ')}`])
    })
    return () => d.dispose()
  }, [])

  const send = (): void => {
    const value = text.trim()
    if (!value) return
    setLines((prev) => [...prev, `→ 发送: ${value}`])
    window.hostAPI.emitEvent('demo.ping', value)
    setText('')
  }

  /**
   * 只有「更多」菜单，没有标签页 —— 视图不必填满外壳的每一项能力。
   * 日志为空时菜单项也是空的，宿主随之把「更多」按钮收起来（一个点开是空面板的
   * 按钮比没有按钮更糟）。
   */
  const chrome = useViewChrome({
    moreItems: lines.length > 0 ? [{ id: 'clear', label: '清空日志' }] : []
  })

  return (
    <ViewFrame chrome={chrome}>
      <div className="flex h-full min-h-0 flex-col text-zinc-200">
        <div className="min-h-0 flex-1 space-y-1 overflow-auto p-3 font-mono text-[11px] leading-4">
          {lines.length === 0 ? (
            <div className="text-zinc-500">
              插件宿主已连通。输入内容并发送，主进程会通过 host:event 回显。
            </div>
          ) : (
            lines.map((l, i) => <div key={i}>{l}</div>)
          )}
        </div>
        <div className="flex shrink-0 gap-2 border-t border-zinc-800 p-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send()
            }}
            placeholder="plugin host self-test"
            className="min-w-0 flex-1 rounded bg-zinc-800 px-2 py-1 text-xs outline-none"
          />
          <button
            onClick={send}
            className="shrink-0 rounded bg-blue-600 px-3 py-1 text-xs hover:bg-blue-500"
          >
            发送
          </button>
        </div>
      </div>
    </ViewFrame>
  )
}
