# NIDE — Novel IDE

AI 辅助的**小说工程化** IDE 编辑器。

> **项目处于初期。** 下面「目标」是方向，「现状」逐条列了仓库里**真实存在**的东西。
> 两者混着看会把规划当成已实现的功能。

## 目标

| 方向 | 内容 |
|---|---|
| 基础 IDE | 文本编辑、Git 版本管理等 |
| 插件宿主 | 一切能力以插件形式扩展 |
| AI Agent 辅助写作 | 作为**内置插件**：文笔优化、写作建议与规划、一致性检查 |
| 小说架构 | 项目说明、大纲、世界观、人物说明、伏笔管理、章节概述 |

技术选型：Electron（客户端框架）+ Monaco（编辑器）+ TypeScript。

## 现状

已落地：

- **工作台骨架** —— IDEA 式七分区布局，可拖拽、可显隐，布局持久化到 localStorage
- **Monaco 集成** —— 编辑器与 Diff 对比视图
- **自定义窗口骨架** —— 无边框 + 自绘标题栏，多窗口复用同一套骨架（见下）
- **插件宿主** —— 扫描内置/第三方插件目录、注册视图贡献点与权限、带路径穿越防护的
  沙箱文件 API；插件 UI 由渲染进程在构建期用 `import.meta.glob` 打包
- **本地化** —— 四层机制（宿主词条表、语言包插件、插件 manifest 文案、Monaco NLS）
- **工程门禁** —— typecheck / lint / 测试三个脚本已接进 `npm run check`
- **设置窗口** —— 左树 + 右页的全局设置；语言可切换，插件可查看与启用/禁用（见下）

尚未实现：

- **Git 版本管理** —— `src/main/services/` 目前只有 `file.service.ts`，没有任何 git 集成
- **AI Agent 插件** —— `plugins/builtin/ai-agent/` 目前是**空目录**
- **小说架构** —— 项目说明、大纲、世界观、人物、伏笔、章节概述等的数据模型与界面尚未开始
- **插件后端沙箱** —— 宿主目前只读 manifest，不启动插件后端子进程（见
  `src/main/plugin-host/loader.ts` 的说明）
- **插件市场** —— 设置里的「插件市场」标签页只有一句占位文案
- **插件卸载与启用状态的持久化** —— 卸载按钮一律置灰；启用状态只在本次运行内有效
- **「项目设置」** —— 在标题栏下拉里**不显示**（宿主还没有「打开项目」这个概念，
  没有项目时它不该出现），设置树里也还没有对应分组
## 窗口

宿主**所有**窗口都从 `src/main/window.ts` 的 `buildWindow()` 出去，共用同一套骨架：

```
┌──────────────────────────────────────────────────────────┐
│ [图标] 标题                       [设置▾]  —  □  ✕        │  ← 自绘标题栏（WindowFrame）
├──────────────────────────────────────────────────────────┤
│                                                          │
│                     内容区（各窗口自己的根组件）              │
└──────────────────────────────────────────────────────────┘
```

- **无边框**：Windows / Linux 用 `frame: false`，三个系统按钮由渲染进程自绘
  （`src/renderer/src/window/`）；macOS 用 `titleBarStyle: 'hiddenInset'` 保留系统交通灯，
  因此**不**渲染右侧那三个按钮 —— 绿色那颗的语义是「全屏」而不是「最大化」。
- **拖拽区**：`-webkit-app-region: drag` 加在标题栏最外层，它是**继承**的，任何可点区域
  （设置按钮、下拉栏、三个按钮）都必须写回 `no-drag`。
- **复用的是「窗口」而不是「主窗口那条标题栏」**：`WindowFrame` 只固定三样东西 ——
  拖拽区、左侧的应用身份（图标 + 标题）、右侧的三个窗口按钮。标题栏动作（那个「设置」
  按钮）由各窗口自己通过 `actions` 传进来，所以设置窗口里不会再出现一颗设置按钮。
- **窗口种类**在 `src/shared/window/index.ts` 的 `WINDOW_TYPES` 里登记，建窗时经
  `additionalArguments` 同步喂给渲染进程，渲染进程据此选根组件（`main.tsx` 的 `ROOTS`）。
  加一种窗口要同时改三处，漏掉哪一处都是编译期可见的。
- **设置入口**：标题栏右侧、最小化左边那颗按钮弹出下拉栏，目前只有「全局设置」
  （打开独立的设置窗口，已开着就聚焦、不重复开）。
- **设置窗口是主窗口的子窗口**：跟着主窗口一起关（Electron 的 parent 语义），居中在
  **主窗口**上（不是屏幕 —— `BrowserWindow.center()` 是屏幕居中，多显示器下会跑偏），
  并且始终浮在主窗口之上。切语言重建主窗口时它也会一起消失，这是刻意的：留着会出现
  「主窗口英文、设置窗口中文」。

> 标题栏和窗口按钮都是渲染进程画的，**没有**自动化测试覆盖 —— 需要 `npm run dev` 手动验证。
> 测试跑不起来时（`spawn EPERM`）是沙箱不允许 esbuild 起子进程，不是代码问题。

## 设置窗口

左树 + 右页 + 右下角按钮条（确定 / 取消 / 应用）。

```
┌──────────────┬───────────────────────────────────────────┐
│ ▾ 通用        │  [插件市场] [已安装]                       │
│    语言       │ ┌────────────┬──────────────────────────┐ │
│   插件        │ │ ☑ 内置      │  插件名        [需重启]    │ │
│               │ │   ☑ demo    │  版本 / 来源 / 目录        │ │
│               │ │ ☑ 用户安装  │  重启需求 / 权限 / 视图    │ │
│               │ └────────────┴──────────────────────────┘ │
│               │                        [确定][取消][应用]  │
└──────────────┴───────────────────────────────────────────┘
```

顶层两项（通用 / 插件）是**平级**的；嵌套只用在真有分层的地方 —— 语言属于通用，
插件不属于任何东西。`SETTINGS_TREE` 里那两条就是全部结构。

### 设置树

- `src/renderer/src/settings/pages.ts` 里的 `SETTINGS_TREE` 是唯一事实来源，树和页面表
  都由它长出来。加一页设置 = 加一个 `page` + 一个标题词条 + 一个组件。
- **父项和子项都能点**，区别只在有没有登记页面：
  - 登记了 `page` → 显示那个页面；
  - 没登记 → 显示**默认页**（`SettingsIndexPage`），一列指向它子设置的链接。这不是
    「未实现」占位，而是「父设置自己没有内容可看，那就把人送到子设置去」。
  - 有页面**且**还有子节点时，页面下面再跟一组子设置链接 —— 否则那些子节点只存在于
    树上，而树是可以收起的，等于把它们藏死了。
- 可任意嵌套，像文件夹一样收起 / 展开（箭头只管开合，不改选中项）。
- 打开设置窗口时默认停在**第一个有页面的节点**，而不是第一个顶层容器 —— 落到容器上
  等于先看目录再点一下才能办事。

### 草稿模型

页面自己攒未应用的改动，只把三件事交给按钮条（`SettingsPageProps`）：脏不脏、
提交 / 丢弃、以及这次提交有没有动到**需要重启**的插件。切页 = 丢弃上一页草稿。

- **「立即重启」**：提交后如果有插件声明了 `requiresRestart: true`，弹一个自绘的确认框
  （立即 / 稍后）。选「立即」走 `host:restart-app` —— 复用切语言那条 `recreateMainWindow`，
  它已经处理好「先建新窗再拆旧窗」的顺序问题。
- **`requiresRestart` 由插件自己在 manifest 里声明**，宿主不猜：只有插件知道自己的东西
  是不是落在某个「启动时读一次就不再刷新」的地方。内置的英文语言包就是这个例子
  （词条表在 `initI18n()` 时构建成载荷缓存起来），所以它的 manifest 里写了这个字段。
- **语言是草稿模型的例外**：换语言要重建整个窗口，而设置窗口就在被重建之列，所以点下去
  即刻生效，「取消」退不回去。页面上写明了这一点。

### 插件页

- 启用状态**真的生效**（禁用后视图从工作台消失，主进程广播给主窗口重拉），
  但**不落盘**（重启回到全部启用）、**不碰磁盘**（卸载按钮一律置灰，内置插件的提示是
  「内置不可卸载」，用户插件的提示是「尚未实现」—— 分开说，前者是永久设计，后者是待办）。
- 「插件市场」标签页只有一句占位文案。
- 语言切换**不再**挂在侧边按钮条的右键菜单上：切语言会丢未保存内容、需要确认，而右键
  菜单是个轻量无确认的交互面，把破坏性操作塞进去不划算。现在它只在设置窗口的语言页。

## 环境要求

- **Node**：仓库的工具链（install / typecheck / lint）只在 **Node 24.21.0** 上跑过。
- npm

注意应用**运行时不受系统 Node 影响** —— Electron 自带 Node 与 V8，系统 Node 只服务于
构建和测试工具（Vite / Vitest / ESLint / tsc）。所以换 Node 版本出问题，坏的是工具链，
不是应用本身。

下游依赖自己声明的范围是：`electron@44` 要求 `>= 22.12.0`，`vitest@5` 声明
`^22.12.0 || ^24.0.0 || >=26.0.0`（注意**不含 25.x**）。这些数字是**它们的**兼容性
声明，不是本项目的验证结论 —— 22.12+ / 24.x 大概率可用，26+ 完全没试过。

所以 `package.json` 里刻意**不写 `engines`**：与其写一个没实测过的范围，不如不写。
等真的在 CI 上跑通多个版本再补。

## 快速开始

```bash
npm install
npm run dev          # 开发（HMR）
npm run check        # 门禁：类型检查 + lint + 测试
npm run build:win    # 打包（另有 build:mac / build:linux）
```

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动开发环境（HMR） |
| `npm run check` | `typecheck` + `lint` + `test`；`build` 与 CI 都走它 |
| `npm test` / `test:watch` | 跑测试 / 监听模式 |
| `npm run typecheck` | 分别检查 node 侧与 web 侧两个 TS 工程 |
| `npm run lint` / `format` | ESLint / Prettier |
| `npm run build` | 跑门禁后构建主进程 / 预加载 / 渲染三份 bundle，**不出安装包** |
| `npm run build:win` / `:mac` / `:linux` | 在 `build` 基础上用 electron-builder 出对应平台安装包 |
| `npm run build:unpack` | 只出解包目录（`--dir`），调试用 |

## 目录结构

```
src/
  main/                      主进程
    index.ts                 启动顺序编排（顺序有约束，见文件注释）
    window.ts                建窗 / 重建窗口 —— 所有窗口唯一的出口
    i18n/                    宿主本地化
      index.ts               启动语言解析、词条载荷、漏翻体检
      language-packs.ts      语言包注册表（合并与优先级）
      manifest-nls.ts        插件 manifest 文案的 %key% 解析
      preference.ts          语言偏好持久化（userData）
    plugin-host/             插件宿主：扫描 manifest、注册贡献点
    ipc/host.ipc.ts          IPC 通道、原生菜单、插件清单
    ipc/window.ipc.ts        窗口控制（最小化/最大化/关闭/开窗）
    services/                主进程服务
  preload/                   contextBridge 桥接层（同步暴露启动 locale 与窗口种类）
  renderer/src/              渲染进程（React）
    MainApp.tsx              主窗口装配（工作台 + 窗口骨架）
    window/                  自绘窗口骨架：标题栏、窗口按钮、设置下拉
    settings/                设置窗口：左树 + 页面注册表 + 各设置页
    plugins/                 插件 UI 的加载与宿主上下文注入
    stores/                  zustand store
    layout/ editor/          工作台骨架与 Monaco 封装
  shared/                    主进程与渲染进程共用的纯逻辑
    i18n/                    宿主词条表、t()、语言包类型
    plugin-api/              插件契约（manifest schema、视图描述、插件清单、context）
    window/                  窗口契约（种类、IPC 通道、状态结构）
plugins/builtin/<name>/      内置插件（见下）
test/                        Vitest 测试
```

## 插件

插件是 `plugins/builtin/<目录名>/` 下的一个目录，至少含 `manifest.json`。
宿主**只读它的 manifest**，不启动插件后端 —— 因此插件的元信息必须是纯数据。

```jsonc
{
  "id": "builtin.demo",
  "name": "Demo Plugin",
  "version": "0.1.0",
  "permissions": ["fs:read"],
  "contributes": {
    "views": [
      {
        "id": "demo.hello",
        "title": "%demo.hello.title%",   // 见「本地化」一节
        "icon": "file",                   // 内置图标名，或一整段 SVG 字符串
        "location": "rightTop",           // 7 个位置之一
        "entry": "src/ui/index.tsx"       // 相对插件目录
      }
    ],
    "locales": [
      { "locale": "en-US", "label": "English", "file": "locales/en-US.json" }
    ]
  }
}
```

`location` 可选值：`leftTop` `leftBottom` `rightTop` `rightBottom` `bottomLeft`
`bottomRight` `main`。（`sidebar` / `panel` 是旧契约，会被自动映射。）

插件 UI 由渲染进程在**构建期**用 `import.meta.glob` 打包 —— 渲染进程在 Chromium
沙箱里没有 fs，无法加载任意磁盘路径。新增插件后需要重启 dev server，它的 UI 入口
才会被重新收集进那张映射表。

## 本地化

分**四**层，互不干涉。**中文是宿主内建的兜底，其余语言都靠语言包覆盖。**

### 1. 宿主自己的文案

唯一事实来源是 `src/shared/i18n/locales/zh-CN.ts`。它的 key 集合就是 schema：

```ts
import { useT } from '@renderer/stores/i18n.store'
const t = useT()
t('host.diff.close')          // key 写错是**编译错误**
```

语言包是**纯数据插件**，用 `contributes.locales` 声明。取词是一条**逐 key 的瀑布**：

```
第三方包  ->  内置包  ->  中文基础表
```

每个 key **各自**沿链找第一个提供它的包 —— 不是「整份包互相覆盖」。所以一个只翻了
一半的第三方包是**可用**的：它翻过的那几条生效，没翻的那几条由内置包接住，内置包也
没有的才落回中文。举个具体的：

| | a | b | c |
|---|---|---|---|
| 第三方 A（`vendor.a`） | a1 | — | — |
| 第三方 B（`vendor.b`） | a2 | b2 | — |
| 内置 | a3 | b3 | c3 |
| **实际生效** | **a1** | **b2** | **c3** |

链的排序有三层，从外到内，三层都是确定的（不依赖磁盘扫描顺序）：

1. **tier**：第三方 -> 内置。用户主动装的包优先，否则装了不生效。
2. **locale 具体度**：请求 `en-GB` 时，`en-GB` 包 -> `en` 包（语言变体之间**不**互相
   兜底：请求 `en-GB` 时 `en-US` 包够不着）。
3. **pluginId 字典序**：同 tier、同具体度下的先后。

一个 key 被链上多个包提供时，靠前的胜出，其余记进启动日志的冲突清单（译文完全相同的
重复提供不算冲突）。日志还会按包汇报「我供给了多少条」，用来定位某条文案到底是谁给的
——见 `LocaleDiagnostics.providers`。

**切换语言需要重建窗口才会生效**（会丢掉未保存的编辑器内容，所以切换前有确认框）。
入口是**设置窗口的语言页**（标题栏的「设置」→「通用」→「语言」），页面上写明了它不吃
「取消」。侧边按钮条的右键菜单只剩「显示工具窗口名称」一项 —— 那是无确认的轻量交互面，
不适合放破坏性操作。

### 2. 插件的 manifest 文案（如视图标题）

用 `%key%` 占位符，词条放插件目录下：

```
plugins/builtin/demo/
  manifest.json              "title": "%demo.hello.title%"
  package.nls.json           插件自己声明的默认语言
  package.nls.en-US.json     某个语言的翻译
```

解析链：`精确 locale → 放宽的 locale（en-US 命中 en）→ 默认表 → 原样 %key%`。
最后一档刻意保留原样，让漏翻**显眼**而不是静默变空。只有整串被 `%` 包住才算占位符，
所以 `"100% done"` 这类标题是安全的。

### 3. 插件 UI 自己的文案

宿主只提供"现在是什么语言"和插值机制，**词条数据归插件**：

```tsx
import { usePluginTranslator } from '@renderer/plugins/host-context'

const MESSAGES = {
  'zh-CN': { clicked: '已点击 {count} 次' },
  en: { clicked: 'Clicked {count} times' }
}

const t = usePluginTranslator(MESSAGES)   // 表定义在模块作用域
t('clicked', { count })
```

### 4. Monaco 的界面文案

Monaco 的右键菜单、查找框走它**自己**的 NLS 机制，不在上面三层里：
宿主加载 `monaco-editor/nls/lang/<locale>.js`，且必须在 monaco 模块被求值**之前**设好
全局（见 `src/renderer/src/monaco-env.ts` 与 `main.tsx` 的启动顺序）。
Monaco 的英文是内建默认，**不存在 `en` 文件**。

因此**切换语言必须重建窗口**（会丢掉未保存的编辑器内容，所以切换前有确认框）。

### 安装第三方语言包

放到用户数据目录下的 `plugins/<任意目录名>/`：

放到用户数据目录下的 `plugins/<任意目录名>/`：

| 平台 | 路径 | 本机状态 |
|---|---|---|
| Windows | `%APPDATA%\nide\plugins\` | **已核实**，磁盘上就是小写 `nide` |
| macOS | `~/Library/Application Support/nide/plugins/` | 未验证 |
| Linux | `~/.config/NIDE/plugins/` | 未验证 |

目录名来自 Electron 的 `app.getName()`。两个容易踩的点：

1. **`productName` 优先于 `name`。** `package.json` 与 `electron-builder.yml` 两边都声明了
   `productName: NIDE`，所以应用名是 `NIDE`。（这条来自 Electron 文档，未在本机实测。）
2. **Windows 与 macOS 的文件系统不区分大小写**，`nide` 和 `NIDE` 是**同一个目录**，
   磁盘上保留先创建的那个大小写 —— 本机就是小写 `nide`。所以这两条路径不会因为
   大小写而分裂。**Linux 区分大小写**，两者是不同目录 —— 这正是要在 `package.json`
   里也声明 `productName` 的原因：让 dev 与打包版都落在 `NIDE`。

结构同内置语言包（`manifest.json` + 词条 JSON）。同一个 locale 同时有内置包和第三方包时，
第三方包**逐 key** 优先 —— 它没翻的 key 自动由内置包接住，不会被整份作废。启动日志会列出
被压下去的具体 key，以及每个包实际供给了多少条文案。

### 漏翻怎么发现

- **构建期**：`npm test` 里的数据校验会穷举比对宿主基础表、各语言包、各插件 manifest 词条
  的 key 集合，少一条多一条都直接失败。
- **运行期**：启动时把「链上一个包都没翻」的 key、多余的 key、以及被压下去的冲突打到
  主进程控制台。逐 key 瀑布下「某个包漏翻」不再是错误 —— 后面的包会接住它。

## 测试

```bash
npm test
```

覆盖范围是**不依赖 electron 的纯逻辑**：locale 归一化与候选链、Monaco locale 映射、
语言包合并与优先级、manifest `%key%` 解析、加载器对不可信输入的处理（路径穿越、
坏 JSON、非字符串值），以及仓库内本地化数据的一致性。

**未覆盖**：窗口重建、原生菜单、确认框、Monaco NLS 实际生效、IPC 往返、自定义标题栏的
一切（拖拽、三个窗口按钮、设置下拉）、以及设置窗口（设置树、草稿模型、插件启用/禁用、
右键菜单）—— 这些集成面需要手动 `npm run dev` 验证。
