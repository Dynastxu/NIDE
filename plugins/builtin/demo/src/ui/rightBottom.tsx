import { type JSX } from 'react'
import { DemoPanel } from './shared/DemoPanel'

/**
 * 下拉式标签条的样例视图（右下工具区）。
 *
 * 与平展那一版（leftTop）是**同一个组件**，只差 `tabStrip` 一个值 —— 视图选样式，
 * 宿主负责画。窄工具区里下拉样式比平展更实用：标签多到一行放不下时不必横向滚动。
 */
export default function RightBottomView(): JSX.Element {
  return <DemoPanel hint="plugins/builtin/demo/src/ui/rightBottom.tsx" tabStrip="dropdown" />
}
