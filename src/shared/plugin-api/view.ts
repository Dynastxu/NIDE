export type ViewLocation =
  'leftTop' | 'leftBottom' | 'rightTop' | 'rightBottom' | 'bottomLeft' | 'bottomRight' | 'main'

/**
 * 主进程 -> 渲染进程 传递的视图元信息。
 *
 * 里面只有数据：没有模块、没有函数、没有绝对路径、没有盘符。
 * 渲染进程拿它去查自己构建期生成的 glob 映射表。
 */
export interface PluginViewDescriptor {
  /** 视图唯一 ID，例如 'demo.hello' */
  id: string
  /** 视图标题。同时作为按钮 tooltip 和区域标题栏文字 */
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
