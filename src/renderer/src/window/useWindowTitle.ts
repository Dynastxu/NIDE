import { useT } from '@renderer/stores/i18n.store'
import { windowTitle } from '@shared/window'

/**
 * 当前窗口**自绘标题栏**上的标题。
 *
 * 只有窗口自己的名字，**不带项目名** —— 主窗口的项目名由标题栏里的项目下拉显示
 * （见 ProjectSelector）。窗口种类在启动参数里，所以第一帧就是对的；规则本身在
 * shared/window，和主进程 / `document.title` 用的是同一份词条（见那里的
 * windowTitle 与 systemWindowTitle）。
 */
export function useWindowTitle(): string {
  const t = useT()
  const { windowType } = window.__NIDE_BOOT__
  return windowTitle(t, windowType)
}
