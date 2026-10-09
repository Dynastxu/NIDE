import { JSX, ReactNode } from 'react'
import { WindowControls } from '@renderer/window/WindowControls'
import iconUrl from '../../../../resources/icon.png?url'

/**
 * 自定义标题栏 —— 宿主**所有**窗口共用的一条。
 *
 * 左边：应用图标 + 标题 + （主窗口才有的）菜单栏与项目下拉；
 * 右边：标题栏动作（如「设置」）+ 最小化 / 最大化-还原 / 关闭。
 *
 * 「复用」的边界在**窗口**这一层，不是把主窗口那一条标题栏整根塞给所有窗口：
 * 每个窗口的内容区、标题、标题栏动作都不一样。所以这里只固定三样东西 ——
 * 拖拽区、左侧的应用身份（图标 + 标题）、右侧的三个窗口按钮 —— 其余留白，
 * 由各窗口自己填。
 *
 * 布局上有三件事必须一起做对，缺一个标题栏就会「不像系统画的」：
 *
 * 1. **拖拽区**。`-webkit-app-region: drag` 加在最外层，让整条都能拖动窗口。
 *    它是**继承**的：任何要接收点击的子树（标题栏动作、下拉栏、三个按钮）都得
 *    显式写回 no-drag，否则点击会被当成拖动窗口的动作吞掉。下拉栏尤其要注意 ——
 *    它是从按钮里长出来的浮层，父链上全是 drag 区。
 * 2. **左上角让位**。macOS 用 `hiddenInset`，红黄绿三个按钮是系统画的、位置也
 *    由系统定（左边约 78px），我们必须把内容推开，否则图标会被它们压住。
 *    见 window.ts 的 frameOptions()。
 * 3. **右侧按钮在 macOS 上不画**。系统已经画了，而且绿色那颗的语义是「全屏」
 *    而不是「最大化」，自绘一份只会有两套互相矛盾的按钮。
 */
export function WindowFrame({
  title,
  leading,
  actions,
  children
}: {
  title: string
  /**
   * 紧贴应用名右侧的区域（主窗口的菜单按钮 + 项目下拉）。
   *
   * 刻意与 `actions` 分开：`actions` 在标题栏**最右边**（设置按钮、三个窗口按钮
   * 那一侧），而菜单栏在左侧挨着应用名 —— 两者在标题栏上是对角，放同一个槽位就
   * 只能用绝对定位硬掰。
   */
  leading?: ReactNode
  /** 标题栏动作，排在三个窗口按钮**左边**。不传就没有 —— 子窗口通常不需要 */
  actions?: ReactNode
  children: ReactNode
}): JSX.Element {
  /**
   * 平台判断放在渲染进程而不是 preload 里转发 `process.platform`：
   * 这个分支只影响样式（要不要留出交通灯的位置），判断错了最多是标题位置
   * 差一点，不会让功能失效。为它多铺一条跨进程数据通道不值得。
   *
   * 用 userAgent 而不是 navigator.platform：前者在 Electron 里稳定带
   * "Macintosh"，后者已经被标准化成越来越没用的值。
   */
  const isMac = navigator.userAgent.includes('Macintosh')

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-zinc-900 text-zinc-200">
      {/* 右侧刻意**不留**内边距：三个窗口按钮要贴死窗口边缘，和原生标题栏一致
          （Windows 的关闭按钮就顶在右上角）。留一条缝的话，那几像素既不响应
          按钮也不响应拖拽，是个能被注意到的死区。 */}
      <div className="flex h-8 shrink-0 items-center bg-zinc-950 select-none [-webkit-app-region:drag]">
        {/* 让开 macOS 的系统交通灯（它们固定在最左边） */}
        {isMac && <div aria-hidden="true" className="w-[78px] shrink-0" />}

        {/* 应用身份：图标 + 标题。所有窗口都有这一段。
            它是唯一的 flex-1：标题长了会截断，并把这之后的一切推到右边 */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-2.5">
          <img src={iconUrl} alt="" aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="truncate text-xs text-zinc-400">{title}</span>

          {/* 菜单按钮 / 菜单栏、项目下拉都挂在这里：它们在视觉上属于「靠左的那一组」，
              跟着应用名，而不是跟着右边的窗口按钮 */}
          {leading}
        </div>

        {actions}

        {/* macOS 上系统已经画了三个按钮，这里整体不渲染（见文件头第 3 条） */}
        {!isMac && <WindowControls />}
      </div>

      {/* min-h-0 是关键：flex 子项默认 min-height:auto，不加这一条内部的工作台
          会被自己的内容撑高，把标题栏挤出可视区（或让整页出现滚动条） */}
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
    </div>
  )
}
