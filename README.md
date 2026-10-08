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
- **插件宿主** —— 扫描内置/第三方插件目录、注册视图贡献点与权限、带路径穿越防护的
  沙箱文件 API；插件 UI 由渲染进程在构建期用 `import.meta.glob` 打包
- **本地化** —— 四层机制（宿主词条表、语言包插件、插件 manifest 文案、Monaco NLS）
- **工程门禁** —— typecheck / lint / 测试三个脚本已接进 `npm run check`

尚未实现：

- **Git 版本管理** —— `src/main/services/` 目前只有 `file.service.ts`，没有任何 git 集成
- **AI Agent 插件** —— `plugins/builtin/ai-agent/` 目前是**空目录**
- **小说架构** —— 项目说明、大纲、世界观、人物、伏笔、章节概述等的数据模型与界面尚未开始
- **插件后端沙箱** —— 宿主目前只读 manifest，不启动插件后端子进程（见
  `src/main/plugin-host/loader.ts` 的说明）

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
    window.ts                建窗 / 重建窗口
    i18n/                    宿主本地化
      index.ts               启动语言解析、词条载荷、漏翻体检
      language-packs.ts      语言包注册表（合并与优先级）
      manifest-nls.ts        插件 manifest 文案的 %key% 解析
      preference.ts          语言偏好持久化（userData）
    plugin-host/             插件宿主：扫描 manifest、注册贡献点
    ipc/host.ipc.ts          IPC 通道、原生菜单
    services/                主进程服务
  preload/                   contextBridge 桥接层（含同步暴露的启动 locale）
  renderer/src/              渲染进程（React）
    plugins/                 插件 UI 的加载与宿主上下文注入
    stores/                  zustand store
    layout/ editor/          工作台骨架与 Monaco 封装
  shared/                    主进程与渲染进程共用的纯逻辑
    i18n/                    宿主词条表、t()、语言包类型
    plugin-api/              插件契约（manifest schema、视图描述、context）
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

语言包是**纯数据插件**，用 `contributes.locales` 声明。合并顺序即优先级：

```
中文基础表  ->  内置语言包  ->  第三方语言包（覆盖内置）
```

**切换语言需要重建窗口才会生效**（会丢掉未保存的编辑器内容，所以切换前有确认框）。
入口在侧边按钮条的右键菜单 —— 这是宿主目前唯一的原生菜单面，等有了设置界面应当挪过去。

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

结构同内置语言包（`manifest.json` + 词条 JSON）。同一个 locale 被内置与第三方同时提供时
**第三方整份覆盖内置**；译文相同的重复提供不算冲突。启动日志会列出被覆盖的具体 key。

### 漏翻怎么发现

- **构建期**：`npm test` 里的数据校验会穷举比对宿主基础表、各语言包、各插件 manifest 词条
  的 key 集合，少一条多一条都直接失败。
- **运行期**：启动时把缺失/多余/冲突的 key 打到主进程控制台。

## 测试

```bash
npm test
```

覆盖范围是**不依赖 electron 的纯逻辑**：locale 归一化与候选链、Monaco locale 映射、
语言包合并与优先级、manifest `%key%` 解析、加载器对不可信输入的处理（路径穿越、
坏 JSON、非字符串值），以及仓库内本地化数据的一致性。

**未覆盖**：窗口重建、原生菜单、确认框、Monaco NLS 实际生效、IPC 往返 ——
这些集成面需要手动 `npm run dev` 验证。
