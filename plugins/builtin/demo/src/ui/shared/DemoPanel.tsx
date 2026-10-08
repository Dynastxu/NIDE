import { useState, type JSX } from 'react'

/**
 * 各分区示例视图共用的外壳。
 *
 * 刻意**不画自己的标题**：视图名由宿主显示在侧边按钮条的图标下面，
 * 内容区里再重复一遍就是占地方。
 *
 * 放在 src/ui/shared/ 下也是刻意的：PluginSlot 的 import.meta.glob 只匹配
 * src/ui 目录下「一层」的 tsx 文件，glob 里的星号不跨目录分隔符，所以这个
 * 文件不会被当成插件视图入口，只能被同目录下的入口文件 import。
 */
export function DemoPanel({ hint }: { hint: string }): JSX.Element {
  const [count, setCount] = useState(0)

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-3 text-zinc-300">
      <div className="min-h-0 shrink-0 font-mono text-[11px] leading-4 break-all text-zinc-500">
        {hint}
      </div>
      <button
        type="button"
        onClick={() => setCount((c) => c + 1)}
        className="mt-auto shrink-0 self-start rounded bg-zinc-800 px-2 py-1 text-[11px] hover:bg-zinc-700"
      >
        已点击 {count} 次
      </button>
    </div>
  )
}
