import type { ReactElement } from 'react'

/**
 * 宿主内置图标集：图标名 -> SVG 内层内容。
 *
 * 约定（新增图标请照抄）：
 * - 24×24 viewBox，纯描边，**不要写死颜色和线宽**，由外层统一注入
 *   fill=none / stroke=currentColor / stroke-width=1.75，
 *   这样图标才能跟着按钮的 text-* 一起变暗变亮。
 * - 只用 path / circle / rect / line 这类基础图元，坐标写死，
 *   不要用 transform 和渐变，保证在任何缩放下都清晰。
 */
export const BUILTIN_ICONS: Record<string, ReactElement> = {
  /** 文档 */
  file: (
    <>
      <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
      <path d="M13 3v6h6" />
    </>
  ),

  /** 文件夹 */
  folder: (
    <path d="M4 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.7.9l1 1.6a2 2 0 0 0 1.7.9H20a2 2 0 0 1 2 2v8.6a2 2 0 0 1-2 2z" />
  ),

  /** 搜索 */
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20.5 20.5-4-4" />
    </>
  ),

  /** 终端 */
  terminal: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <path d="m7 9.5 3 2.5-3 2.5" />
      <path d="M13 15h4" />
    </>
  ),

  /** 活动 / 信号（心跳线） */
  activity: <path d="M3 12h4l3-7 4 14 3-7h4" />,

  /** 星芒（AI） */
  sparkle: <path d="M12 3.5 14 10 20.5 12 14 14 12 20.5 10 14 3.5 12 10 10Z" />,

  /** 列表 */
  list: (
    <>
      <path d="M9 6h12M9 12h12M9 18h12" />
      <circle cx="4" cy="6" r="1.2" />
      <circle cx="4" cy="12" r="1.2" />
      <circle cx="4" cy="18" r="1.2" />
    </>
  ),

  /** 代码 */
  code: (
    <>
      <path d="m9 7.5-4.5 4.5L9 16.5" />
      <path d="m15 7.5 4.5 4.5L15 16.5" />
    </>
  ),

  /** 数据库 */
  database: (
    <>
      <ellipse cx="12" cy="5.5" rx="7.5" ry="3" />
      <path d="M4.5 5.5v13c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3v-13" />
      <path d="M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3" />
    </>
  ),

  /** 设置 / 滑杆 */
  sliders: (
    <>
      <path d="M5 3.5v6.5M5 14v6.5M12 3.5v3.5M12 11v9.5M19 3.5v9M19 17v3.5" />
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="9" r="2" />
      <circle cx="19" cy="14.75" r="2" />
    </>
  ),

  /** 图层 */
  layers: (
    <>
      <path d="m12 3 9 4.5-9 4.5-9-4.5z" />
      <path d="m3 12.5 9 4.5 9-4.5" />
      <path d="m3 16.5 9 4.5 9-4.5" />
    </>
  ),

  /** 分支 */
  gitBranch: (
    <>
      <circle cx="6.5" cy="5.5" r="2.5" />
      <circle cx="6.5" cy="18.5" r="2.5" />
      <circle cx="17.5" cy="8.5" r="2.5" />
      <path d="M6.5 8v8" />
      <path d="M17.5 11c0 3.5-2.8 5-6.2 5H9" />
    </>
  ),

  /** 新建 / 添加 */
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),

  /** 菜单（三条横线）。折叠状态的菜单按钮用它 */
  menu: (
    <>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </>
  ),

  /** 勾选。下拉列表里标「当前项」 */
  check: <path d="m5 13 4.5 4.5L19 6.5" />,

  /** 下拉箭头 */
  chevronDown: <path d="m6 9.5 6 6 6-6" />,

  /** 关闭（叉）。菜单里表示「关掉当前这个东西」 */
  close: (
    <>
      <path d="m6 6 12 12" />
      <path d="M18 6 6 18" />
    </>
  ),

  /** 退出应用（电源） */
  power: (
    <>
      <path d="M12 3.5v8" />
      <path d="M7 6.8a8 8 0 1 0 10 0" />
    </>
  ),

  /** 撤销（向左回折的箭头） */
  undo: (
    <>
      <path d="m9 14-5-5 5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </>
  ),

  /** 重做（撤销的镜像） */
  redo: (
    <>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </>
  ),

  /** 面板 / 布局 */
  panel: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <path d="M9.5 4v16" />
    </>
  )
}

export function getBuiltinIcon(name: string): ReactElement | undefined {
  return BUILTIN_ICONS[name]
}

export function builtinIconNames(): string[] {
  return Object.keys(BUILTIN_ICONS)
}
