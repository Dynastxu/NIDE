import { useEffect, useState, type JSX } from 'react'

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

  return (
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
  )
}
