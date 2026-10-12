export type ViewLocation =
  'leftTop' | 'leftBottom' | 'rightTop' | 'rightBottom' | 'bottomLeft' | 'bottomRight' | 'main'

/**
 * 宿主**内建**视图的贡献者 id。
 *
 * 内建视图（文件树这种宿主自己的功能）和插件视图走**同一张**视图表、同一套按钮条
 * 与工具区：一个区同一时刻只展示一个视图，如果内建视图另走一条路，就会出现
 * 「插件视图和内建视图同时占着左上角」这种没有答案的布局问题。
 *
 * 用这个 id 才不会和真插件撞名：插件 id 由 manifest 自己声明，约定是
 * `<来源>.<插件目录名>`（内置插件 `builtin.`，第三方插件在 userData 下，
 * 例如 `builtin.demo` / `user.lang-en`）。
 *
 * 整个 `host` / `host.*` 命名空间由宿主保留。这不是靠约定维持的：加载器
 * 用 isReservedHostId 在注册之前拒绝占用它的 manifest id 或视图 id
 * （见 plugin-host/loader.ts），否则一个第三方 manifest 就能把内建视图
 * 挤出同一张视图表。
 *
 * 渲染进程据此把内建视图交给宿主的组件表（HostSlot），插件视图仍走
 * import.meta.glob 那套。
 */
export const HOST_VIEW_PLUGIN_ID = 'host'

/**
 * `host` 命名空间的保留前缀。
 *
 * `host` 本身已经由 HOST_VIEW_PLUGIN_ID 占用，`host.` 前缀则是内建视图 id 的
 * 专属空间。两者合起来构成宿主的保留 id 空间：插件既不能叫这些名字，也不能
 * 注册这些视图 id —— 否则一个第三方 manifest 就能把内建视图挤出视图表。
 */
const HOST_NAMESPACE_PREFIX = `${HOST_VIEW_PLUGIN_ID}.`

/**
 * 这个 id 是否落在宿主保留的 `host` 命名空间里。
 *
 * 纯函数，不读任何注册表：加载器要用它**在注册之前**拦下越界的 manifest，
 * 因此它不能依赖「已经注册了什么」。
 *
 * 判据是整个命名空间而不是 HOST_VIEW_PLUGIN_ID 一个值：撞上 `host.explorer`
 * 这类 id 会把内建视图挤出视图表（UIRegistry 是同名覆盖），同属越界。
 * `hostile` 这种只是前缀相同的普通名字不算越界。
 */
export function isReservedHostId(id: string): boolean {
  return id === HOST_VIEW_PLUGIN_ID || id.startsWith(HOST_NAMESPACE_PREFIX)
}

/** 文件树视图的 id。渲染进程按它选组件，主进程按它注册 */
export const HOST_EXPLORER_VIEW_ID = 'host.explorer'

/**
 * 版本控制视图的 id：侧边按钮条左下角那颗按钮对应的占位视图。
 *
 * 和文件树一样是宿主内建视图，走同一张视图表 —— 侧边按钮条与工具区不需要为它
 * 开第二条路。目前只有一行占位文案，没有接任何版本控制实现。
 */
export const HOST_GIT_VIEW_ID = 'host.git'

/**
 * 提交视图的 id：标题栏「文件 -> 提交」打开的占位视图。
 *
 * 动作在菜单里，但页面仍然是**视图**：菜单只负责把某个区切到它（见 MainMenu），
 * 页面本体由 HostSlot 按 id 渲染，与按钮条上的视图共用同一套装配。
 */
export const HOST_COMMIT_VIEW_ID = 'host.commit'

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
