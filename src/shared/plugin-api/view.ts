export type ViewLocation =
  'leftTop' | 'leftBottom' | 'rightTop' | 'rightBottom' | 'bottomLeft' | 'bottomRight' | 'main'

/**
 * 宿主**内建**视图的贡献者 id。
 *
 * 内建视图（文件树这种宿主自己的功能）和插件视图走**同一张**视图表、同一套按钮条
 * 与工具区：一个区同一时刻只展示一个视图，如果内建视图另走一条路，就会出现
 * 「插件视图和内建视图同时占着左上角」这种没有答案的布局问题。
 *
 * 用这个 id 才不会和真插件撞名：插件的 id 由 manifest 声明，格式是
 * `<发布者>.<插件名>`，不会有人叫 `host`。
 *
 * 渲染进程据此把内建视图交给宿主的组件表（HostSlot），插件视图仍走
 * import.meta.glob 那套。
 */
export const HOST_VIEW_PLUGIN_ID = 'host'

/** 文件树视图的 id。渲染进程按它选组件，主进程按它注册 */
export const HOST_EXPLORER_VIEW_ID = 'host.explorer'

/**
 * 主进程 -> 渲染进程 传递的视图元信息。
 *
 * 里面只有数据：没有模块、没有函数、没有绝对路径、没有盘符。
 * 渲染进程拿它去查自己构建期生成的 glob 映射表。
 */
export interface PluginViewDescriptor {
  /** 视图唯一 ID，例如 'demo.hello' */
  id: string
  /**
   * 视图标题。同时作为按钮 tooltip 和区域标题栏文字。
   *
   * 主进程已经按**当前语言**解析过 manifest 里的 `%key%` 占位符了，
   * 渲染进程直接显示这个字符串即可，不要再做任何语言判断。
   */
  title: string
  /** 挂载位置 */
  location: ViewLocation
  /**
   * 工具区按钮的图标，由**视图自己**声明。**只接受 SVG**，两种写法：
   *
   * - 自定义：一整段 SVG 字符串（必须含 '<'），宿主会把尺寸压到 16×16。
   *   颜色线宽自己控制，建议用 stroke='currentColor' 才能跟着按钮明暗。
   * - 内置：只写宿主内置图标名，例如 'file' / 'terminal' / 'search'，
   *   描边样式由宿主统一注入。名字表见 renderer 的 layout/icons.tsx。
   *
   * 不声明（或名字拼错）时回落到宿主的分区示意图 —— 同样是 SVG。
   * 图标体系里没有位图，也没有字体字形：emoji 这类值会被当作未知名字拒绝。
   */
  icon?: string
  /** 所属插件 ID，例如 'builtin.demo' */
  pluginId: string
  /** 插件目录名（plugins/builtin/<dir>），例如 'demo' */
  dir: string
  /** UI 入口：相对于插件目录的 POSIX 路径，例如 'src/ui/index.tsx' */
  entry: string
}
