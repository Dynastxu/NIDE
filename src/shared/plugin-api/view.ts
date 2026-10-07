/**
 * 主进程 -> 渲染进程 传递的视图元信息。
 *
 * 里面只有数据：没有模块、没有函数、没有绝对路径、没有盘符。
 * 渲染进程拿它去查自己构建期生成的 glob 映射表。
 */
export interface PluginViewDescriptor {
  /** 视图唯一 ID，例如 'demo.hello' */
  id: string
  /** 视图标题 */
  title: string
  /** 挂载位置 */
  location: 'sidebar' | 'panel' | 'main'
  /** 所属插件 ID，例如 'builtin.demo' */
  pluginId: string
  /** 插件目录名（plugins/builtin/<dir>），例如 'demo' */
  dir: string
  /** UI 入口：相对于插件目录的 POSIX 路径，例如 'src/ui/index.tsx' */
  entry: string
}
