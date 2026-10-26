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
 * 整个 `host` / `host.*` 命名空间由宿主保留。这不是靠约定维持的：host 读插件
 * 贡献点时用 isReservedHostId 在注册之前拒绝占用它的 manifest id 或视图 id
 * （见 packages/host/src/services/plugin-contributions.ts），否则一个第三方
 * manifest 就能把内建视图挤出同一张视图表。
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
 * 视图外壳（标题栏 + 标签条）的显隐开关。
 *
 * 每一条都只回答「画不画」，不回答「画什么」：文案、图标、标签列表和菜单项都是
 * **运行时**由视图自己给的（见 renderer 的 view/useViewChrome），因为那些东西随
 * 视图状态变化，而 manifest 是静态 JSON。
 *
 * 这里写的是**默认值**，不是不可撤销的禁令：视图的代码在自己的渲染期可以逐项覆盖
 * （`useViewChrome` 的 `configure`）。理由是表达力 —— 一份静态声明说不出「只有在有
 * 内容时才画标题栏」这类条件（主编辑区一个文件都没打开时正是那样），而视图的代码
 * 说得出。反过来，视图没提的那几项照旧按这里走。
 *
 * 全部**默认 true**：视图什么都不写就得到「标题栏 + 标题 + 最小化按钮」这套最基本的
 * 外壳。没有声明这一项的旧 manifest 同样落到默认值，不需要迁移代码。
 */
export interface ViewChromeOptions {
  /** 画标题栏那一行。false 时下面的 title/tabs 等开关随之失去意义 */
  header?: boolean
  /** 标题栏左侧显示视图标题 */
  title?: boolean
  /**
   * 显示「更多」按钮。
   *
   * 这一项只是**允许**：视图没有给出任何菜单项时，按钮依然不画 ——
   * 一个点开是空面板的按钮比没有按钮更糟。
   */
  more?: boolean
  /** 显示最小化按钮（收起这个区）。视图不能收起自己时声明 false */
  minimize?: boolean
  /** 在标题栏里画标签条。视图没有标签时它自然不占位 */
  tabs?: boolean
}

/**
 * 视图外壳全部开关都打开时的取值。
 *
 * 用**完整**字段而不是 Partial：合并逻辑里少一个字段就会让 Object.assign 悄悄
 * 把 undefined 写进去，界面上的表现是「某一项明明声明了却不生效」。
 */
export const DEFAULT_VIEW_CHROME: Required<ViewChromeOptions> = {
  header: true,
  title: true,
  more: true,
  minimize: true,
  tabs: true
}

/**
 * 标签条样式。
 *
 * - `flat`：一行平展的标签页，横向溢出时滚动（默认）；
 * - `dropdown`：收成一个下拉按钮，选中项写作按钮文案 —— 窄工具区里比平展标签
 *   更实用，标签多到一行放不下时不必横向滚动去找。
 */
export type ViewTabStrip = 'flat' | 'dropdown'

/**
 * 可关闭标签页右侧那个按钮的形状。
 *
 * - `close`：叉号，直白地表示「点它会关掉」（默认）；
 * - `dot`：圆点。用来承载视图自己的状态（文件还没保存、有未读结果……），
 *   鼠标悬停时才露出关闭的动作 —— 状态和操作共用同一个位置，标签条不会为了
 *   两者各占一格宽度。
 */
export type ViewTabCloseIcon = 'close' | 'dot'

/**
 * 视图外壳（标题栏）上的一条「更多」菜单项。
 *
 * 刻意比宿主自己的 MenuItem 少：图标在这里只接受**内置图标名**，不接受任意 SVG。
 * 这条契约要跨 IPC 传给渲染进程并在插件之间流通，一个宽松字段迟早会变成
 * `dangerouslySetInnerHTML` 的注入口。视图要自己的字形，就把它画在视图里。
 */
export interface ViewMoreItem {
  /** 稳定 id，React 的 key 与日志都用它 */
  id: string
  label: string
  /**
   * 点它做什么。
   *
   * 只有**渲染期**给出的菜单项带得动它（函数跨不了进程）：manifest 里静态声明的
   * 那一份菜单项是纯数据，省略它就是个只显示、点不动的条目。真实用例在
   * `useViewChrome` 那一侧（编辑器标签页的「关闭其他」就是它）。
   */
  onSelect?: () => void
  /** 宿主内置图标名（见 renderer 的 layout/icons.tsx） */
  icon?: string
  /** 置灰 */
  disabled?: boolean
  /** 置灰时鼠标悬停给出的原因 */
  disabledReason?: string
  /** 危险动作（删除之类），用红色悬停底 */
  danger?: boolean
}

/** 一个标签页在标题栏里的状态标识 */
export type ViewTabStatus = 'none' | 'dot'

/**
 * 标题栏里的一个标签页。
 *
 * 这是**纯数据**：视图在自己的 state 里维护这份数组，交给宿主画出来。
 * 内容留在视图自己手里（宿主只画这一行），所以标签页与视图正文之间不需要
 * 再走任何回调 —— 除了 `onSelectTab` / `onCloseTab` 两个动作。
 */
export interface ViewTab {
  /** 稳定 id，React 的 key 与「当前是哪一个」的判据 */
  id: string
  /** 标签文字 */
  label: string
  /** 鼠标悬停的完整说明（标签会被截断，完整路径之类放这里） */
  title?: string
  /**
   * 这个标签是否可关闭。
   *
   * 省略时跟随外壳的 `tabsClosable`。逐标签覆盖是必要的：一组标签里常常
   * 只有一部分该被关掉（编辑器里的文件全可关，而「设置」这种固定页不可关）。
   */
  closable?: boolean
  /** 覆盖默认的关闭按钮形状。省略时跟随外壳的 `closeIcon` */
  closeIcon?: ViewTabCloseIcon
  /** 内容被改动的标识；`dot` 时标签上会常显一个圆点 */
  status?: ViewTabStatus
}

/**
 * 视图外壳上的一个自定义按钮。
 *
 * 类型写成 `unknown` 是**刻意**的：这一层（shared）同时被主进程加载，而主进程没有
 * 也不该有 React 的类型。渲染进程拿到之后按 ReactNode 用（见 renderer 的
 * view/ViewTabStrip 的 ChromeSlot），那里才是它真正的类型。
 */
export type ViewSlotContent = unknown

/**
 * 视图可以自己挂按钮的位置。
 *
 * 三处都在标题栏里，而且互不重叠 —— 「标签右侧」与「更多左侧」是两个不同的
 * 挂载点，所以视图有两处可选：紧贴标签（`tabs.after`）和紧贴更多按钮
 * （`actions`）。一个都不给就是三处都不画。
 */
export interface ViewChromeSlots {
  /** 标签条上的三个位置。三个字段都可省略，只声明用得上的那几个 */
  tabs?: {
    /** 标签条左端：标题与第一个标签之间 */
    before?: ViewSlotContent
    /** 标签条右端：最后一个标签与「更多」按钮之间 —— 最主要的一个位置 */
    after?: ViewSlotContent
    /** 单个标签页内部、关闭按钮的左侧 */
    tab?: ViewSlotContent
  }
  /** 「更多」按钮左侧、标签条右侧；没有标签条时就是标题右侧 */
  actions?: ViewSlotContent
  /** 标题右侧、标签条左侧 */
  title?: ViewSlotContent
}

/** 视图正文对外的两个标签页动作。标签页是视图自己的状态，所以动作也归视图实现 */
export interface ViewChromeController {
  selectTab: (id: string) => void
  closeTab: (id: string) => void
}

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
  /**
   * 视图外壳的显隐开关（静态部分）。
   *
   * 运行时那一半 —— 标签、菜单项、标题栏里的按钮 —— 由视图自己在渲染期给出
   * （见 renderer 的 view/useViewChrome）：那些东西随视图状态变化，而这份描述
   * 是启动时算好、整份下发的纯数据。
   */
  chrome?: ViewChromeOptions
  /** 所属插件 ID，例如 'builtin.demo' */
  pluginId: string
  /** 插件目录名（plugins/builtin/<dir>），例如 'demo' */
  dir: string
  /** UI 入口：相对于插件目录的 POSIX 路径，例如 'src/ui/index.tsx' */
  entry: string
}
