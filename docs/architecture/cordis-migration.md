# NIDE → Cordis / DSH 架构迁移方案

状态：决策已锁定，待执行
基线：`pre-cordis` tag（迁移开始前打）
性质：破坏性重构（当前无用户，不做数据迁移）

## 当前进度

- **2026-10-25：host 骨架跑通**（阶段 1 的第一步）。
  - 新增 [packages/boot](../../packages/boot/src/index.ts)：`NIDE_HOME` 解析、profile 首次初始化、`cordis.yml` 读取、`--dump-config`。
  - 新增 [packages/host](../../packages/host/src/index.ts)：Cordis 4 `Context` + loader 启动 + `SIGINT/SIGTERM` 优雅退出。
  - 新增 [packages/hello](../../packages/hello/src/index.ts)：最小插件，验证激活、日志与 effect 释放。
  - 新增 [profiles/desktop](../../profiles/desktop)：profile 模板（`package.json` / `cordis.yml` / `cordis.patch.yml`）。
  - 命令：`pnpm host:dump`、`pnpm host:smoke`、`pnpm typecheck:host`。
  - 依赖已 pin：`@deepseek-ai/cordis@4.0.5`、`cordis-plugin-loader@1.0.6`、`include@1.0.10`、`group@1.0.5`、`timer@1.1.7`、`js-yaml@4.3.2`；npm 走 npmmirror。
  - **shell ↔ host 握手已接上**：[src/main/host/process.ts](../../src/main/host/process.ts) 用 `utilityProcess.fork` 拉起 host，等 `ready`，支持 `ping/pong` 与 `shutdown`。**host 现在是启动必需**：文件 / 配置的实现全在它里面；另有 `invokeHost` 走父端口做 shell → host RPC（新建项目时的 `config.initialize`）。
  - [packages/host/src/ipc.ts](../../packages/host/src/ipc.ts) 同时支持 Electron `process.parentPort` 与 Node `child_process.fork` 的 IPC 载体。
  - 冒烟脚本：[scripts/host-ipc-node-smoke.mjs](../../scripts/host-ipc-node-smoke.mjs)（纯 Node；已通过）。真实 Electron 启动用 `pnpm dev` 验证，日志里能看到 `host process is ready`、`ipc=true` 与 `Host port attached`。
  - **renderer ↔ host 直连 port 已接**：主进程在 `did-finish-load` 后用 `MessageChannelMain` 把 port 分给 host 与 renderer；preload 暴露 `window.nideHost.invoke(namespace, method, ...args)`。
  - **通用 RPC 骨架已跑通**：协议在 [src/shared/host-rpc](../../src/shared/host-rpc/index.ts)，host 侧 [RpcRegistry](../../packages/host/src/rpc.ts) 负责分发/错误包装，首个 namespace 是 `host.info`；renderer 启动后调用它。
  - **第一个业务 namespace 已接**：`project.list` / `current` / `startup`。纯数据模型从 `src/shared/project` 拆到 [store.ts](../../src/shared/project/store.ts)（无 `@shared` 别名，host 可直接 import），Electron 侧的 `projects.json` 由 shell 通过 `--user-data` 传给 host。
  - **preload 的 `projects.list` 已切到 host**：port 到达后走 `nideHost.invoke('project','list')`，失败自动回落旧 IPC；日志里出现 `project.list served by host`。
  - **文件读取已切到 host**：`files.readDir` / `files.readFile` 注册在 host；preload 的 `projects.readDir/readFile` host 优先、失败回退。复用 `src/shared/project/files.ts` 的纯规则，只把碰盘那一半放进 `packages/host/src/services/project-files.ts`。
  - **保存已切到 host**：`files.writeFile` 走同一套范围/符号链接/格式校验，落盘仍是「同目录临时件 + 原子 rename」；preload 的 `projects.writeFile` host 优先、失败回退。
  - **新建 / 改名 / 删除已切到 host**：`files.createEntry` / `renameEntry` / `deleteEntry` 在 [packages/host/src/services/project-files.ts](../../packages/host/src/services/project-files.ts)，范围、符号链接、绝不覆盖、项目根不可删这些边界与主进程那份逐条一致；preload 三条都 host 优先、失败回退旧 IPC。删除的二次确认留在 shell（host 没有窗口）：preload 先 `host:project-confirm-delete` 再调 host，回退时带 `{ confirm: false }` 避免问两遍。
  - **章节 / 伏笔 / 图鉴 / 概述 / 配置已切到 host**：`files.readChapters` / `readForeshadowing`、`gallery.read/create/updateRegistry`、`overview.read/setRole`、`config.read/update` 注册在 host；preload 全部 host 优先、失败回退。图鉴 / 概述「报上来的路径必须正是配置里那个目录」的核对也在 host（配置服务已搬进 [packages/host/src/services/project-config.ts](../../packages/host/src/services/project-config.ts)），改名后的概述映射由 host 的 `remapOverviewRole` 直接补。
  - **shared/project 变成 host 可直接加载**：目录内模块之间改用 `#project/*`（[src/shared/project/package.json](../../src/shared/project/package.json) 的 `imports`），不再用 `@shared/*` 或免扩展名相对路径 —— Node 的 ESM 解析器不认后者。原 `src/shared/yaml` 搬成 `src/shared/project/yaml.ts`，归到同一个包作用域里。
  - **shell 侧重复实现已删**：`src/main/services/project-{files,config}.service.ts` 删除；`project.ipc.ts` 只剩项目列表 / 打开 / 关闭、删除确认，其余旧通道全部**转发**到 host（与 preload 直连 port 共用同一张 `RpcRegistry`）。`config.initialize` 由 shell 经 `invokeHost`（utilityProcess 父端口）调用；host 启动不再受 `NIDE_HOST` 控制。8 份服务测试搬到 [test/host](../../test/host)，由 `tsconfig.host.json` 一起检查。
  - **插件清单已切到 host**：[packages/host/src/services/plugins.ts](../../packages/host/src/services/plugins.ts) 扫描内置 / 第三方目录，维护 manifest、禁用集合与 client bundle；RPC 为 `plugins.list/disabled/setEnabled/clientBundles/install/remove/rescan`。shell 的 `getPlugins` / `getDisabledPlugins` / `getClientBundles` host 优先、失败回退，`setPluginEnabled` 先写 host 再同步 shell 内存镜像（视图过滤与 i18n 仍读它）。视图 / 设置页 / 语言包注册仍在 shell；安装 / 卸载后由 `rescanPluginHost()` 重扫并广播。
  - **插件安装 / 卸载 / 信任确认**：`plugins.install(sourceDir)` 从本地文件夹复制进 `<userData>/plugins`、默认禁用；`plugins.remove(id)` 只删第三方。shell 的 `host:install-plugin` 负责选目录、`host:remove-plugin` 负责卸载确认；启用第三方插件时 `setPluginEnabled` 先过 `enableThirdPartyPlugin` 信任确认，取消则返回 false。npm 来源与 profile patch 还没做。
  - **插件浏览器半补加载（dev）**：`plugin:enabled-changed` 到达主窗口时先 `reloadClientBundles()` 再重拉视图列表；dev 的 Vite `server.fs.strict=false` 允许 `/@fs/` 读 userData 里的第三方 bundle。新装 / 启用的 UI 插件不用重启。生产协议仍 TODO。
  - **客户端 Cordis 树已起**：[packages/client-runtime](../../packages/client-runtime/src/index.ts) 在 renderer 里建独立根 Context + 一个最小插件，挂到 `window.__NIDE_CLIENT__`。
  - **第一个 slot 已接**：`@nide/client-ui-slots` 提供注册表，`@nide/client-ui-renderer` 提供不产生包装 DOM 的 `<Slot>`；欢迎窗口改走 `<Slot name="welcome.root">`，渲染的仍是现有 `WelcomeApp`（组件一行没改）。
  - **主窗口 root 也已接**：`@nide/client-ui-main` 把现有 `App` 注册到 `main.root`；`client-runtime` 按 `windowType` 只加载对应插件，主窗口不会拖入 WelcomeApp，欢迎窗口也不会加载 Monaco。settings 仍走旧路径。
  - **六个工具区已接 slot**：`@nide/client-ui-layout` 注册 `zone.leftTop` … `zone.bottomRight`；`WorkbenchLayout` 改成 `<Slot name="zone.*" fallback={<ToolZone .../>}>`，客户端树没起来时仍走 fallback。
  - **视图组件注册表已接**：`@nide/client-modules` 提供 `ClientModuleRegistry`；`PluginSlot` 优先查注册表、未命中再回退构建期 `import.meta.glob`。
  - **插件 UI 的运行时 bundle 已接（dev + 打包后）**：manifest 的 `client` 声明 → host 的 `plugins.clientBundles` → `client-runtime` 注入 IIFE → `__NIDE_REGISTER__` → `ClientModuleRegistry`。开发期用 Vite `/@fs/`；打包后走 shell 注册的 `nide-plugin://plugin/<pluginId>/client.js`（处理器只按 pluginId 去 host 清单里查路径，CSP 的 `script-src` 里列了这个 scheme）。详见 [plugin-ui-bundles.md](plugin-ui-bundles.md)。
  - **三个窗口都走 slot 了**：`main.root` / `welcome.root` / `settings.root` 分别由 `client-ui-main` / `client-ui-welcome` / `client-ui-settings` 注册，渲染的仍是现有组件。
  - **当前项目同步**：host 启动时 `resolveStartup()`；每个窗口 port 建立后把 `--nide-project=` 的路径发 `project.setCurrent`，换项目时 host 跟着切。
  - **项目生命周期已全部搬到 host**：`project.open/forget/close` 接上 RPC，shell 的 `src/main/services/project-store.ts` 删除；建窗要等 host 的启动结论（`openStartupWindow()` 变 async，首窗晚约 0.4s），shell 只留 `boundProjectPath`（主窗口**绑定**的项目，重建窗口时复用）。host 不可达时开项目返回 `unreadable`，不再谎称「目录不存在」。`test/host/project-store.test.ts` 覆盖这套语义。
  - **插件贡献点也搬到 host 了**：唯一读插件目录的是 [plugin-contributions.ts](../../packages/host/src/services/plugin-contributions.ts)（manifest、路径守卫、chrome/location 收敛、语言包、`package.nls*.json`），经 `plugins.contributions` 下发；shell 的 loader / plugin-registry / permission / sandbox / errors 全删，只剩四张缓存表 + 「按当前语言解析 `%key%`」。[src/shared/plugin-api/contributions.ts](../../src/shared/plugin-api/contributions.ts) 是这条跨进程契约（`titleSpec` 不解析、路径只用插件目录内相对 POSIX）。语言标签规范化拆到自包含的 [locale-tag.ts](../../src/shared/i18n/locale-tag.ts)，host 才能直接加载。
  - **生产 bundle 协议已接**：`nide-plugin://` 自定义协议（standard + secure，ready 前登记 scheme、ready 后挂处理器），渲染进程只给 pluginId，路径由 host 清单回答；`clientBundles` 同时过滤掉声明了 `client` 但文件不存在的条目，让渲染进程安静回退 glob。
  - **本地化也搬到 host 了**：[services/i18n.ts](../../packages/host/src/services/i18n.ts) 持有语言包注册表（逐 key 瀑布：第三方 -> 内置 -> 中文基础表）、语言偏好（`<userData>/locale.json`）与 manifest 标题解析；RPC 是 `i18n.init({system})` / `setLocale` / `payload`。`plugins.views` / `plugins.settings` 直接下发**已解析标题**的描述符，shell 的 `language-packs` / `preference` / `manifest-nls` 与四张缓存表全删，只剩一份 `I18nPayload` 缓存（窗口标题、菜单、对话框要同步取文案）。`test/host/i18n.test.ts` 覆盖瀑布与偏好。
  - **主题 / 外观也搬到 host 了**：[services/appearance.ts](../../packages/host/src/services/appearance.ts) 持有 `appearance.json` 偏好与主题解析，`nativeTheme` 通过反向桥（`shell.call`）设置；shell 只缓存一份 `AppearanceState`（窗口底色与启动参数要同步）。共享层为此把 `theme/builtin.ts` 改成纯数据、`appearance/preference.ts` 独立成自包含文件。
  - **`ctx.shell` 反向桥已接**：`shell-call` / `shell-result` 协议 + host 的 `ShellBridge` + shell 的 `capabilities.ts`（`nativeTheme` / `safeStorage` 白名单）。这是 D7 的第一块，也是 AI/secrets 搬家的前置。
  - **AI 供应商与密钥仓也搬到 host 了**：[services/ai-provider.ts](../../packages/host/src/services/ai-provider.ts) + [secrets.ts](../../packages/host/src/services/secrets.ts)（密文落盘，加解密走 `safeStorage` 反向桥，测试注入假后端）。RPC 因此多了 `stream-event` 流式通道（`ai.open` 返回 requestId，分片由 host 推给 shell 再转给发起窗口）；shell 的 `ai-provider.ipc.ts` 只剩启用检查、窗口归属与形状校验。
  - **客户端共享层已抽出**：[packages/client-kit](../../packages/client-kit/src)（stores / ui / window 外壳 / logger / icons / palette / 插件视图渲染管线），别名 `@nide/client-kit/*`；渲染进程的窗口级代码改为 import 它，kit 不反向依赖渲染进程。
  - **欢迎 / 设置两个窗口已进包**：`client-ui-welcome` 与 `client-ui-settings` 里现在是真的组件（不再包一层 `@renderer/*`），引导壳按包名动态 import。
  - **D1 完成**：主窗口的 `App` / `MainApp` / 编辑器 / 文件树 / 布局 / 内建视图表 / 文件菜单也进了 `client-ui-main`，`monaco-env` 进 kit；`src/renderer/src` 只剩 `main.tsx`（引导壳）+ `assets` + `env.d.ts`。旧的 `@renderer` 别名已从所有配置里删除。仍可选的后续优化是把主窗口内部拆成 `zone.*` / `editor.*` 子 slot。
  - **host 有了编译产物，asar 也回来了**：`pnpm build:host` 把 host / boot / hello / 共享层编到 `out/host`（统一 ESM、产物根 `{"type":"module"}`、`#project/*` 映射与 profile 模板一并改写），打包版跑 `out/host/.../index.js` 并由 shell 传 `--dist-root`；源码形式的 `packages/*` 不再进包。asar 开启后，host 需要的真实文件（`out/host/**`、`plugins/**`）通过 `asarUnpack` 落在 `app.asar.unpacked/`，shell 负责换根。代码签名仍未配（走 `CSC_LINK` / `CSC_KEY_PASSWORD`）。
  - 已知 TODO：bundle/patch 分层、`!!js`、required 审计、runtime resolution 均未做；`cordis.yml` 里的 `{{NIDE_ROOT}}` 是开发期占位符，正式形态应换成包标识符。
- 下一步：**收尾**。① 删掉 shell 的 IPC 转发回退 / 禁用集合镜像 / `host-views` 表；
  ② `build:win` 实跑与签名证书；③ D10 与视觉回归。

## 0. 已锁定决策

| 编号 | 结论 |
| --- | --- |
| D1 | A：全量 dogfood，应用本身是一份插件组合，核心 UI 也是 client 插件 |
| D2 | A：host 跑在独立 Node 进程，Electron main 只做 shell |
| D3 | A：Cordis 4.x + ESM（宿主、shell 主进程都走 ESM） |
| D4 | A：客户端插件用 DSH 式 client modules（宿主发 bundle + 惰性 factory + 平台模块表） |
| D6 | 第三方插件只从 npm 安装；默认禁用；启用时确认“拥有完整 Node 权限”；官方 bundle 走白名单 |
| D7 | 对齐 DSH：插件不 import electron；桌面能力由 shell 通过 `ctx.shell` 暴露 |
| D8 | A：DSH 式命名 slot |
| D9 | Monaco 进平台模块表，但只暴露 `@nide/editor-api` |
| D10 | B：i18n 改为每包 `locale/*.json` + client locale 服务 |
| D17 | 框架层直接依赖公开包；引擎层从公开仓库 vendor 固定版本；UI 层不引入 DSH 包 |

硬约束：**视觉不变**。按钮的位置、颜色、字号、间距、窗口 chrome、默认布局、视图顺序，全部与现状一致。架构换，渲染结果不换。

## 1. 目标形态

### 1.1 进程

```
Electron shell（apps/shell）
├─ BrowserWindow / Menu / dialog / tray / autoUpdater
├─ preload（只暴露最小 window.nide）
├─ spawn host（utilityProcess，失败时回退 child_process + ELECTRON_RUN_AS_NODE）
└─ 建窗时用 MessageChannelMain 把两个 port 分别给 host 与 renderer，renderer ↔ host 直连

Host（packages/host，纯 Node ESM）
├─ Cordis root Context
├─ profile / loader / runtime resolution（vendor 自 DSH）
├─ host services：fs / project / git / secrets / i18n / shell bridge
├─ api namespaces：project / workspace / editor / git / ai
└─ 插件 host 半

Client（apps/client，浏览器 Cordis 树）
├─ client modules（vendor 自 DSH，`__NIDE_BOOT__`）
├─ slots + NIDE React renderer
├─ ui 插件：theme / primitives / layout / explorer / editor / settings / welcome / plugins
└─ 插件 client 半
```

### 1.2 目录

```
NIDE/
├─ apps/
│  ├─ shell/                 # 原 src/main + src/preload
│  └─ client/                # 原 src/renderer 的入口与 boot
├─ packages/
│  ├─ boot/                  # profile 解析、loader 启动、patch 合成
│  ├─ host/                  # @nide/host 进程入口
│  ├─ sdk/                   # 插件作者类型与工具
│  ├─ host-services/         # fs/project/git/secrets/i18n
│  ├─ host-shell/            # ctx.shell → shell RPC
│  ├─ api-*/                 # remote namespaces
│  ├─ client-runtime/        # client Cordis 树 + connection
│  ├─ client-modules/        # vendor 后改名
│  ├─ client-ui-slots/       # vendor 纯核心
│  ├─ client-ui-renderer/    # NIDE 自己的 React 绑定
│  ├─ client-ui-theme/       # zinc + .theme-light
│  ├─ client-ui-primitives/  # 按钮/菜单/弹窗
│  ├─ client-ui-layout/      # 七分区 + 按钮条 + Resizer
│  ├─ client-ui-explorer/
│  ├─ client-ui-editor/
│  ├─ client-ui-settings/
│  ├─ client-ui-welcome/
│  ├─ client-ui-plugins/     # 插件管理页
│  ├─ host-plugin-manager/
│  └─ plugin-ai-provider/
├─ profiles/
│  ├─ base/                  # 纯 patch 组合包
│  └─ desktop/               # 纯 patch 组合包
├─ vendor/                   # 固定版本的 DSH 框架包 + PATCHES.md
├─ tests/
│  ├─ visual/                # Playwright Electron 截图基线
│  └─ e2e/
└─ docs/architecture/
```

### 1.3 包分层

| 层 | 例子 | 依赖方向 |
| --- | --- | --- |
| 框架（vendor） | cordis、loader、include、group、timer、schemastery、ui-slots、client-modules、app-boot | 不依赖 NIDE |
| 宿主服务 | host-services、host-shell、api-* | 只依赖框架 + sdk |
| 客户端基础 | client-runtime、client-ui-theme、client-ui-primitives、client-ui-renderer | 只依赖框架 + sdk |
| 功能 UI | client-ui-layout、explorer、editor、settings、welcome、plugins | 依赖客户端基础 |
| 功能插件 | plugin-ai-provider | 依赖 sdk + api-* |

## 2. 视觉不变量

以下内容在全部阶段保持逐字节一致（或截图 diff = 0）：

- 七分区骨架、按钮条通高、底栏不横跨
- 尺寸默认值 260/320/200/260/260/320 与拖拽范围
- 深色 zinc 色阶、`.theme-light`、`nide-scrollbar`
- 32px 自绘标题栏与窗口按钮
- Monaco 配色、字号、行高
- 默认视图顺序（内建视图在前）与 activeView 回落规则
- 首帧语言/主题/深浅（从 argv 同步读取）
- 所有文案（中/英）逐字一致

执行规则：

1. 同一 PR 不允许同时改架构和改外观。
2. 每个阶段结束跑 `pnpm visual`，diff 不为 0 即阻断。
3. UI 组件搬迁时 JSX、class 字符串、CSS 变量名、数值常量一个字不改。
4. 核心 UI 的 CSS 只由 shell 侧一份 Tailwind 构建产出；client 包不各自注入核心 CSS。
5. 不引入 DSH 的 `ui-layout` / `ui-theme` / `ui-primitives` / `ui-renderer`。

## 3. 迁移策略

- **绞杀者模式**：旧 UI 一直可用，直到新链路逐块替代。用 `NIDE_CLIENT=1` 开关切换。
- **IPC 门面**：阶段 2 保留现有 preload API 表面，主进程 handler 改为转发 host RPC。旧 UI 一行不改。
- **零 diff 搬迁**：UI 只做“移动文件 + 换挂载点”，不改渲染。
- **vendor 固定版本**：从公开仓库拷贝所需框架包，记录来源 commit 与补丁；升级时重放补丁。
- **每一步可回滚**：阶段产物在独立分支/开关后，失败即回退该阶段，不影响上一阶段。

## 4. 阶段计划

单人全职估算，总计 18–22 周。

### 阶段 0：冻结基线（3–5 天）

目标：让“外观没变”可被机器验证。

动作：

1. 新建 `tests/visual`：Playwright `_electron.launch()`，截 `main` / `settings` / `welcome` × 深色/浅色 × 1440×900，存 `__screenshots__`。
2. 加 `pnpm visual` 与 CI job（本地先跑）。
3. 打 tag `pre-cordis`。
4. 记录关键 computed style（字体、字号、颜色、间距）作为第二重断言。

验收：`pnpm visual` 全绿；手动把某个 `bg-zinc-900` 改成 `bg-blue-600` 能让它失败。

### 阶段 1：工作区、ESM、宿主进程骨架（2–3 周）

目标：Electron 能拉起一个跑空 Cordis 树的 host 进程，旧 UI 不受影响。

动作：

1. pnpm workspace：`apps/*`、`packages/*`、`vendor/*`；根 `pnpm-workspace.yaml`、`tsconfig.base.json`。
2. 切 ESM：`package.json#type=module`，electron-vite main/preload 输出 ESM；逐个修 CJS 依赖（electron-log、electron-updater）。
3. vendor 框架：cordis 4.0.5、loader/include/group/timer、app-boot、schemastery、ui-slots、client-modules；`vendor/VENDORED.md` 记录版本/commit/补丁。
4. 先 spike 一天：确认 `readProfileManifest('nide', dir)` 这类 `binName` 是否参数化；不能则 fork 改名（`dsh.*` → `nide.*`）。
5. `apps/shell`：spawn host（`utilityProcess`），stdout/stderr 转日志，退出时 kill；handshake（ping/pong）。
6. `packages/host`：`new Context()`，加载 `~/.nide/profiles/default`，`loader` 启动空树，支持 `--dump-config`。
7. `profiles/base`、`profiles/desktop`：各一份 `cordis.patch.yml`，先只放 1–2 行。

验收：

- `pnpm dev` 启动，窗口仍是现有 UI。
- 后台 host 进程存在，`--dump-config` 输出组合结果。
- 退出应用后 host 进程不残留。
- 首次启动自动创建 `~/.nide/profiles/default/{package.json,cordis.patch.yml,node_modules}`。
- 视觉基线 0 diff。

### 阶段 2：宿主服务 + IPC 门面（3–4 周）

目标：把 `src/main` 的业务能力搬到 host，旧 UI 通过门面继续工作。

动作：

1. `packages/host-services`：`ctx.fs`、`ctx.project`、`ctx.projectFiles`、`ctx.git`、`ctx.secrets`、`ctx.i18n`、`ctx.logger`。
2. `packages/host-shell`：`ctx.shell.dialog/menu/clipboard/window` → shell RPC；shell 是唯一能 import electron 的地方。
3. `packages/api-*`：定义 remote namespace 与类型；host 注册 handler。
4. 兼容门面：`apps/shell/ipc/*` 保留现有 `HOST_CHANNELS`，实现改为转发 host；`preload/index.ts` 不动。
5. 迁移服务：`file.service`、`project-*`、`secrets/vault`、`ai-provider` 从 `src/main` 移到 packages。
6. `ctx.i18n`：暂用现有词条表，作为阶段 5 改 per-package locale 的过渡。

验收：

- 旧 UI 全功能可用（项目打开、文件读写、章节/伏笔/图鉴、AI 供应商）。
- `src/main` 不再直接 `fs.readFile` 项目文件。
- 关窗/退出时 host 服务正确 dispose。
- 视觉基线 0 diff。

### 阶段 3：客户端运行时（2–3 周）

目标：浏览器里能跑第二棵 Cordis 树，并渲染一个 slot。

动作：

1. vendor `client-modules` 改名：`__DSH_BOOT__` → `__NIDE_BOOT__`，`dsh.client` → `nide.client`，bundle 路由改为自定义协议（`nide-plugin://`）。
2. `packages/client-runtime`：client `Context`、`ctx.connection`（MessagePort）、`ctx.remote`、`ctx.modules`。
3. `packages/client-ui-slots` + `client-ui-renderer`：slot 注册/渲染；outlet 不产生额外 DOM（必要时 `display: contents`）。
4. `apps/client`：保持 `#root`、body class、CSS link、boot info 字段不变；`NIDE_CLIENT=1` 时挂 client 树。
5. 第一步只做一个 `root` slot，内容临时渲染现有 `<MainApp/>`，验证链路。

验收：

- `NIDE_CLIENT=1` 时窗口内容与旧路径截图 0 diff。
- client 树能 `ctx.plugin()` 一个空插件并正确 dispose。
- 刷新页面不崩、不重复挂载。
- 未设置开关时完全走旧路径。

### 阶段 4：核心 UI 插件化（4–5 周，零 diff）

目标：核心 UI 变成 NIDE 自己的 client 插件，观感不变。

顺序（低风险 → 高风险，每步单独 PR）：

1. `client-ui-theme`：抽出颜色/字体 token，class 名不变。
2. `client-ui-primitives`：Button/Menu/Dialog/Disclosure 等，DOM 不变。
3. `client-ui-layout`：`WorkbenchLayout`、`ToolStripe`、`ToolZone`、`Resizer`；root slot 由它占位。
4. `client-ui-explorer`：文件树、项目面板。
5. `client-ui-editor`：`EditorTabs`、Monaco、Diff；平台模块表 pin `monaco@0.57.0`。
6. `client-ui-settings`：设置窗口根 + 左树。
7. `client-ui-welcome`：欢迎窗口根。
8. `client-ui-plugins`：插件页。

每步动作：移动文件、改 import、注册 slot、更新 Tailwind `@source`、跑截图。旧组件在确认 0 diff 后删除。

验收：

- 每个窗口、两种主题、两种语言截图 0 diff。
- `packages/client-*` 不再 import `@renderer/*`。
- 布局拖拽、视图显隐、标签切换行为与现在一致。
- 首帧无闪烁（与现状逐帧对比或至少无可见 FOUC）。

### 阶段 5：插件包与插件管理（3–4 周）

目标：第三方插件可装、可启停；AI 供应商成为真正的双半插件。

动作：

1. `packages/sdk`：`nide.client` 声明类型、slot 类型、remote 类型、`Plugin` 辅助函数。
2. `plugin-ai-provider`：host 半（服务/SSE）+ client 半（设置页 slot），删除 `src/main/services/ai-provider` 与手写 IPC。
3. 删除 `plugin-host/loader`、`manifest.json`、`ui-registry`、`settings-registry`、`manifest-nls`；语言包改 per-package `locale/*.json`。
4. `host-plugin-manager`：`listPlugins` / `listBundles` / `setPluginEnabled` / `install` / `remove`；实现 `readOnlyReason`（`management-required` / `unaddressable`）与 protected modules。
5. `client-ui-plugins`：移植 `PluginsBrowser`，外观不变。
6. 安装流程：pnpm 装进 `~/.nide/profiles/desktop`，默认禁用，启用弹确认。

验收：

- 装一个本地 `nide.client` 包，出现在插件页；启用后 slot 出现，禁用后消失。
- 重启后启用状态保留（写 profile patch）。
- 管理器自身、loader、client-modules 等控制面包不可停用/卸载，且 UI 有 tooltip。
- 视觉基线 0 diff。

### 阶段 6：切换与收尾（2 周）

动作：

1. `NIDE_CLIENT=1` 变默认，删除旧 `main.tsx` / `App.tsx` 路径。
2. 删除 `src/main/plugin-host`、`src/shared/plugin-api`、兼容 IPC 门面中不再使用的通道。
3. 打包：profile 模板进 resources，host 与原生依赖 `asarUnpack`，pnpm 运行时随包。
4. 测试：单测 + e2e（启动、装卸插件、recompose）+ 视觉，全进 CI。
5. 文档：README、插件作者指南、profile/patch 说明、`docs/wiki` 克隆后补架构页。

验收：

- `pnpm build:win` 产物在干净机器启动，生成 `~/.nide`。
- `pnpm check` 全绿。
- 全新 profile 能装、启、停、卸一个第三方插件。
- 视觉基线 0 diff。

## 5. 首 10 个工作日

| 天 | 任务 | 产出 |
| --- | --- | --- |
| 1–2 | Playwright 视觉基线 + CI job | `tests/visual`，`pnpm visual` |
| 3–4 | workspace + ESM spike（electron-vite main ESM） | `apps/shell` 能 ESM 启动 |
| 5–6 | vendor 固定版本 + `binName` 参数化 spike | `vendor/`、`VENDORED.md`、结论 |
| 7–8 | host 进程 spawn + handshake + 退出清理 | 后台空树跑起来 |
| 9–10 | profile 初始化 + `--dump-config` | `~/.nide` 结构与 dump 输出 |

第 10 天写一份 ADR：ESM 是否可行、`binName` 是否参数化、utilityProcess 是否可靠。三个结论决定后续是否要 fork 更多包。

## 6. 风险与回退

| 风险 | 触发点 | 回退 |
| --- | --- | --- |
| Electron ESM main 不可行 | 阶段 1 | 退回 Cordis 3.18 + CJS（需重定 D3） |
| utilityProcess 加载 asar 失败 | 阶段 1 | `child_process.fork` + `ELECTRON_RUN_AS_NODE=1`，host 放 `asarUnpack` |
| DSH 包 `binName` 未参数化 | 阶段 1 | fork 改名，记录补丁；或内部保留 `dsh.*` 字段（不推荐） |
| client bundle 格式与 Tailwind 冲突 | 阶段 3 | 先单 bundle 不分片；CSS 全部走 shell 全局表 |
| 视觉回归 | 任一阶段 | 阻断该 PR，回到上一 tag |
| vendor 与上游漂移 | 全程 | 只跟固定版本；升级作为独立任务，不在迁移期做 |
| 打包后插件解析失败 | 阶段 6 | 保留 `--no-sandbox` 式诊断入口；host 启动日志落盘 |

## 7. 附录

### 7.1 插件包声明示例

```json
{
  "name": "@nide/plugin-ai-provider",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
  },
  "nide": {
    "client": {
      "platform": "web",
      "inject": ["@nide/client-ui-layout", "@nide/api-ai"]
    }
  },
  "peerDependencies": {
    "@nide/cordis": "^4.0.5",
    "@nide/sdk": "^0.1.0"
  }
}
```

### 7.2 profile 示例

```
~/.nide/profiles/desktop/
├─ package.json          # nide.profile.bundles: ["@nide/base","@nide/desktop"]
├─ cordis.patch.yml      # 用户覆盖层
└─ node_modules/         # pnpm 安装的插件
```

### 7.3 slot 映射

| slot | 现有组件 | 说明 |
| --- | --- | --- |
| `root` | `WorkbenchLayout` | 主窗口根 |
| `stripe.left` / `stripe.right` | `ToolStripe` | 通高按钮条 |
| `zone.leftTop` … `zone.bottomRight` | `ToolZone` | 六个工具区 |
| `editor.tabs` | `EditorTabs` | 标签条 |
| `editor.content` | Monaco / Diff | 编辑器 |
| `settings.nav` / `settings.page` | 设置树 / 页面 | 设置窗口 |
| `welcome.root` | `WelcomeApp` | 欢迎窗口 |
| `plugins.list` / `plugins.detail` | `PluginsBrowser` | 插件页 |

### 7.4 每个阶段的“不许做”

- 不新增视觉变化，包括“顺手优化”。
- 不引入 DSH 的 UI/theme/layout 包。
- 不让插件 `import('electron')` 或直接读 `app.getPath`。
- 不在插件包里注入全局 CSS。
- 不把两个阶段塞进一个 PR。
