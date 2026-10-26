# NIDE 迁移交接（2026-10-26）

> 新会话先读这份，再读 [cordis-migration.md](cordis-migration.md) 与
> [plugin-ui-bundles.md](plugin-ui-bundles.md)。三份都是当前有效的约定，不是历史记录。

## 0. 一句话状态

Cordis/DSH 架构的**核心竖切已经跑通**：Electron shell → 独立 host 进程 → 通用 RPC →
客户端 Cordis 树 → slot → 运行时插件 UI bundle。项目文件 / 章节 / 图鉴 / 概述 /
项目配置的**实现只有一份**，在 host；插件清单 / 启停 / 本地安装 / 卸载 / 信任确认
也在 host。现有界面外观未改。

**但旧实现没有全部迁完**：项目生命周期（open/close/store）、插件 loader / 视图 /
设置页 / 语言包、i18n / theme / AI / secrets、核心 UI 组件仍在 shell 或旧路径
（逐项见 §4.1）。下一步不是继续加新功能，而是按 §4 的顺序把这些搬完。

**当前工作区有未提交的插件安装 / 卸载改动**（`git status` 为准）。

## 1. 目标与已锁定决策

目标：NIDE 的架构对齐 DSH，插件不做沙箱隔离；**UI 长相不变**（位置、颜色、字号、
间距、窗口 chrome 都不变）。

| 编号 | 结论 |
| --- | --- |
| D1 | A：全量 dogfood，核心 UI 也是 client 插件 |
| D2 | A：host 跑独立 Node 进程，Electron main 只做 shell |
| D3 | A：Cordis 4.x + ESM |
| D4 | A：DSH 式 client modules；当前实现为「IIFE + 平台全局」，见 plugin-ui-bundles.md |
| D6 | 第三方插件只从 npm 装；默认禁用；启用要确认 |
| D7 | 插件不 import electron；桌面能力由 shell 通过 `ctx.shell` 暴露（尚未实现） |
| D8 | A：DSH 式命名 slot |
| D9 | Monaco 进平台模块表，但只暴露 `@nide/editor-api` |
| D10 | B：i18n 改为每包 `locale/*.json`（尚未开始） |
| D17 | 框架层直接依赖；引擎层 vendor；UI 层不引入 DSH 包 |

## 2. 目标进程与代码结构

```
Electron shell（src/main）
├─ 窗口 / 菜单 / dialog / tray / update / preload
├─ utilityProcess.fork(packages/host/src/index.ts)   ← 必需（启动时无条件拉起）
└─ 建窗时 MessageChannelMain：一个 port 给 host，一个给 renderer

Host（packages/host，纯 Node ESM）
├─ Cordis root + loader + profile（packages/boot）
├─ RpcRegistry（host/src/rpc.ts）
├─ HostProjectStore（project.list / setCurrent / startup）
├─ 文件读写（services/project-files.ts）：readDir / readFile / readChapters /
│  readForeshadowing / writeFile / createEntry / renameEntry / deleteEntry /
│  gallery / overview 的读与新建
├─ 项目配置（services/project-config.ts）：load / update / initialize / registry /
│  resolve / remapOverviewRole
└─ 插件清单（services/plugins.ts）：list / disabled / setEnabled / clientBundles /
   install / remove / rescan

Client（renderer，HTTP 页面里的第二棵 Cordis 树）
├─ packages/client-runtime：Context + slots + modules + bundle loader
├─ packages/client-ui-*：main / welcome / settings / layout
├─ packages/client-ui-slots / client-ui-renderer
└─ packages/client-modules：viewId -> Component
```

目录：

```
apps/            # 计划中，尚未创建
packages/
  boot/ host/ hello/
  client-runtime/ client-modules/
  client-ui-slots/ client-ui-renderer/
  client-ui-main/ client-ui-layout/ client-ui-welcome/ client-ui-settings/
profiles/desktop/   # package.json + cordis.yml + cordis.patch.yml
vendor/            # 已删除（改用 pnpm 依赖）
docs/architecture/ # 本文件 + 迁移方案 + bundle 说明
```

## 3. 已完成（可运行、已验证）

### 宿主进程
- 启动时 `src/main/host/process.ts` 用 `utilityProcess.fork` 拉起 host（不再是开关）；
- 等 `{type:'ready'}`，支持 ping/pong、shutdown、超时 kill；host 退出后下一次调用会重新拉起；
- host 入口 `packages/host/src/index.ts`：Cordis `Context` + loader + 插件；
- 生命周期日志：`host process is ready`、`host ready ... ipc=true`。

### RPC 与宿主业务
- 协议：`src/shared/host-rpc/index.ts`；host 分发：`packages/host/src/rpc.ts`；
- namespace：`host.info`、`project.list/current/startup/setCurrent`、
  `files.readDir/readFile/readChapters/readForeshadowing/writeFile/createEntry/renameEntry/deleteEntry`、
  `gallery.read/create/updateRegistry`、`overview.read/setRole`、
  `config.read/update/initialize`；
- preload 暴露 `window.nideHost.invoke(ns, method, ...args)`；
- preload 的上面这些 `projects.*` 方法全部 host 优先；旧 IPC 通道保留为回退，但
  **只是转发**——主进程里不再有第二份实现（`src/main/services/project-*.service.ts` 已删）；
- shell → host 也有一条父端口 RPC（`invokeHost`）：新建项目时的
  `config.initialize` 由主进程直接发起，那时窗口可能还没建出来；旧 IPC 的转发器也走它；
- 图鉴 / 概述的「报上来的路径必须正是配置里那个目录」在 host 判：配置服务已经搬过去；
- 删除的二次确认留在 shell（host 没有窗口）：preload 先走
  `host:project-confirm-delete` 问一句，用户同意后再调 host；
- 改名之后的概述映射在 host 内部补（`remapOverviewRole`）；
- `project.setCurrent` 在每个窗口 port 建立后按 `--nide-project=` 同步，换项目时 host 跟着切。

### 插件清单（host）
- [packages/host/src/services/plugins.ts](packages/host/src/services/plugins.ts) 扫描
  `<appRoot>/plugins/builtin` 与 `<userData>/plugins`，维护 manifest 清单、禁用集合与
  client bundle 绝对路径；
- RPC：`plugins.list` / `disabled` / `setEnabled` / `clientBundles` / `install` /
  `remove` / `rescan`；
- shell 的 `getPlugins` / `getDisabledPlugins` / `getClientBundles` 已 host 优先、失败回退；
  `setPluginEnabled` 先写 host，再同步 shell 的内存镜像（视图过滤与 i18n 仍读它），
  然后广播 `plugin:enabled-changed`；
- 视图 / 设置页 / 语言包的注册仍在 shell（依赖 i18n 与构建期 glob），这一层只搬了
  「装了哪些、哪些启用、bundle 在哪」这三份纯数据；
- **安装 / 卸载**：`plugins.install(sourceDir)` 复制到 `<userData>/plugins`、默认禁用；
  `plugins.remove(id)` 只删第三方。shell 负责选目录（`host:install-plugin`）与卸载
  确认（`host:remove-plugin`），成功后 `rescanPluginHost()` 重扫视图 / 设置页 / 语言包，
  并用 `plugin:enabled-changed` 广播让所有窗口重拉；
- **信任确认**：启用第三方插件时走 `CONFIRM_SPECS.enableThirdPartyPlugin`（内置插件
  不问），用户取消则 `setPluginEnabled` 返回 false，界面回滚到宿主的真实禁用集合；
- **浏览器半补加载**：`plugin:enabled-changed` 到达主窗口时先
  `reloadClientBundles()` 再重拉视图列表，所以新装 / 启用的 UI 插件**不用重启**
  就会出现；dev 下 Vite 的 `server.fs.strict` 已关掉，`/@fs/` 也能读 userData 里的
  第三方 bundle。生产环境仍走 app 协议（TODO），非 dev 会跳过 bundle。

### 客户端 Cordis / slots
- `packages/client-runtime`：按 `windowType` 加载 main/welcome/settings 插件；
- `main.root` / `welcome.root` / `settings.root` 都已接入；
- `zone.leftTop` … `zone.bottomRight` 六个工具区已接入；
- `WorkbenchLayout` 用 `<Slot name="zone.*" fallback={<ToolZone .../>}>`，没有注册者时旧路径照常；
- `Slot` 不产生包装 DOM（`createElement`）。

### 插件 UI 运行时 bundle（开发期）
- manifest `client: { platform:'web', bundle:'dist/client.js' }`；
- 主进程 `host:get-client-bundles` → preload → `client-runtime` 注入 IIFE；
- bundle 调 `window.__NIDE_REGISTER__(viewId, Component)` 注册；
- demo 的 bundle 已构建：`plugins/builtin/demo/dist/client.js`（71 KB）；
- 日志已验证：
  ```
  [nide] client bundle loaded
  [nide] client module registered by bundle {"id":"demo.hello"}
  [plugin-view] view served by client modules
  ```
- 没有 bundle 时 `PluginSlot` 回退构建期 `import.meta.glob`。

### 工程
- npm registry 已切 `https://registry.npmmirror.com/`（`.npmrc`）；
- `tsconfig.host.json`；`pnpm typecheck:host`；
- `pnpm host:dump` / `host:smoke`；
- 第一批 `e270b5f`：写路径（新建 / 改名 / 删除）搬完。
- 第二批 `b753126`：章节 / 伏笔 / 图鉴 / 概述 / 配置搬到 host；`src/shared/project`
  改成 `#project/*` 子路径导入（原 `@shared/yaml` 与免扩展名相对导入 Node 解析不了）。
  `pnpm test` 35 files / 583 tests 全绿（Vitest 能解析 `#project/*`）。
- 第三批 `f1cd701`：删掉主进程两份服务实现，旧 IPC handler 改成**转发**到 host；
  `config.initialize` 由 shell 经父端口 RPC（`invokeHost`）调用；host 变成启动必需；
  8 份服务测试从 `test/main/services` 搬到 [test/host](../../test/host)。
- 第四批 `8dbb073`：打包（`asar: false` + host 跑源码），`build:unpack` 产物已验证。
- 第五批（未提交）：插件清单 / 禁用集合 / client bundle 收到 host；新增本地文件夹
  安装、第三方卸载、启用前的信任确认与插件页入口；`test/host/plugins.test.ts`。
  上一轮 592 tests 全绿，安装 / 卸载用例加进来后待重跑。
- `pnpm test` 会跑 `test/host/**`，`pnpm typecheck:host` 同时检查 host 与这些用例。

## 4. 下一步优先级

按「先搬完旧实现，再加功能」排序：

1. **项目生命周期统一到 host**（当前最大的过渡期重复）
   - shell 的 `src/main/services/project-store.ts` 与 host 的 `HostProjectStore`
     各读一份 `projects.json`；open / forget / close 仍在 shell；
   - 目标：host 持有 store，shell 只负责窗口、目录对话框、确认；
   - 迁移时要处理窗口重建与 host 当前项目的同步。
2. **插件 loader / 视图 / 设置页 / 语言包迁 host**
   - 现在 `src/main/plugin-host/*` 全量仍在 shell：loader、permission、sandbox、
     uiRegistry、settingsRegistry、host-views、manifest-nls、语言包；
   - 目标：host 产出纯数据（views / settings / locales），shell 只消费；
   - 前置：i18n 词条表要在 host 侧构建，或 host 下发 contributions 由 shell 合并。
3. **npm 安装来源**（D6）
   - 先定 pnpm 运行时；推荐自带 registry tarball 安装（需加 `tar` 依赖，v1 不做
     传递依赖），替换 `plugins.install` 的 sourceDir 输入，UI 加包名输入；
   - 插件市场标签页暂不做。
4. **生产 bundle 协议**：`nide-plugin://` 或 app 协议 + 批量构建 + CSS 约定 + HMR。
   现在打包版不会加载任何插件 UI（loader 非 dev 直接跳过）。
5. **发布化**：编译 host + 恢复 asar + 代码签名 + `build:win` 验证。
6. **剩余迁移**：i18n / theme / appearance / AI / secrets 服务化；核心 UI 组件搬进
   `client-ui-*`；D10 per-package locale；视觉回归；最后删 `src/main/plugin-host`、
   `src/main/services/project-store.ts`、`PluginSlot` 的 glob 兜底。

### 4.1 迁移完成度（哪些还在旧实现）

**已迁到 host**：项目文件 / 章节 / 伏笔 / 图鉴 / 概述 / 配置；新建项目初始化；
插件清单 / 启停 / 本地安装 / 卸载 / 信任确认；通用 RPC；host 启动必需。

**仍在 shell / 旧实现**：
- 项目 store / open / forget / close（host 有一份只读的 list/current/setCurrent）；
- `src/main/plugin-host/*` 全量（views / settings / locales / loader / permission /
  sandbox / manifest-nls / host-views）；
- i18n / theme / appearance / logger；
- AI provider / secrets；
- window / menu / tray / update / dialog / confirm（按 D7 属于 shell，但 `ctx.shell`
  桥接尚未实现）；
- 核心 UI 组件（`client-ui-*` 目前只是把 `@renderer/App` 等包一层 slot）；
- 生产 bundle 协议、编译 host / asar / 签名、视觉回归、D10。

**旧实现里也没有的**：插件后端（`manifest.main`）、依赖解析、profile bundle /
`cordis.patch.yml` / `!!js` / required 审计 / runtime resolution。

## 5. 运行与验证

```powershell
cd C:\Users\dynas\Documents\Code\NIDE
pnpm dev
```

host 现在是启动必需的，不再需要 `NIDE_HOST`。日志里应能看到
`host process is ready`、`host ready ... ipc=true`、`Host port attached`。

- 主窗口：`main.root` + `zone slots` + demo bundle；
- 欢迎窗口：临时把 `%APPDATA%\NIDE\projects.json` 改名，测完恢复；
- 设置窗口：菜单打开，期望 `settings.root registered`；
- Demo：启用 Demo Plugin，打开 `demo.hello`，应出现
  `view served by client modules`。

常用命令：

```bash
pnpm typecheck
pnpm typecheck:host
pnpm lint
pnpm test                 # 需在普通终端跑
pnpm host:dump
pnpm host:smoke
pnpm build:plugin-demo
pnpm build:unpack        # 打包到 dist/<platform>-unpacked（host 必需，先验这个）
```

### 沙箱限制（重要）

Agent 的执行环境有文件/进程沙箱，以下命令会 `EPERM`，**必须由用户在自己的终端跑**：

- `pnpm install` / `pnpm add`（全局 store 锁 / 删 node_modules）；
- `pnpm test`（vitest 起 esbuild）；
- `pnpm build:plugin-demo`（Vite 在 Windows 上 spawn）；
- 直接启动 Electron GUI。

另外 agent 环境里设了 `ELECTRON_RUN_AS_NODE=1`；跑 Electron 前要
`Remove-Item Env:ELECTRON_RUN_AS_NODE`（用户的普通终端通常没有这个问题）。

## 6. 关键文件

| 文件 | 说明 |
| --- | --- |
| `electron-builder.yml` | 打包：`asar: false`，显式带上 host 源码 / boot / hello / shared / profiles / plugins |
| `src/main/host/process.ts` | spawn host、ready、attach port、`invokeHost`（shell→host RPC）、stop |
| `src/main/index.ts` | 启动时拉起 host；`browser-window-created` 挂 port；`will-quit` 停 host |
| `src/main/ipc/project.ipc.ts` | 项目列表 / 打开 / 关闭 + 删除确认 + 旧通道转发到 host |
| `src/main/ipc/host.ipc.ts` | 其余宿主 IPC（插件、主题、i18n、`host:get-client-bundles`） |
| `src/preload/index.ts` | `nideHost` 桥、host 优先回退、`__NIDE_BOOT__` |
| `src/shared/host-rpc/index.ts` | RPC 协议 |
| `packages/host/src/rpc.ts` | RpcRegistry（renderer port 与 shell 父端口共用） |
| `packages/host/src/ipc.ts` | 父端口 / renderer port 的 transport 与 RPC 分发 |
| `packages/host/src/services/project-store.ts` | host 项目列表 / 当前项目 |
| `packages/host/src/services/project-files.ts` | host 文件 / 章节 / 伏笔 / 图鉴 / 概述的读写 |
| `packages/host/src/services/project-config.ts` | host 项目配置（load / update / initialize / registry / remap） |
| `packages/host/src/services/plugins.ts` | host 插件清单 / 启停 / client bundle / 本地安装卸载（npm 待做） |
| `packages/client-runtime/src/index.ts` | 客户端树、slots/modules、bundle 加载 |
| `packages/client-runtime/src/loader.ts` | `/@fs/` IIFE 注入 |
| `packages/client-ui-slots/src/index.ts` | `SlotRegistry` / `slotsOf` |
| `packages/client-modules/src/index.ts` | `ClientModuleRegistry` / `modulesOf` |
| `packages/client-ui-renderer/src/index.tsx` | `<SlotProvider>` / `<Slot>` |
| `src/renderer/src/plugins/PluginSlot.tsx` | 先查注册表，再回退 glob |
| `plugins/builtin/demo/src/ui/client-entry.tsx` | bundle 入口 |
| `scripts/build-plugin-client.mjs` | IIFE 构建 |
| `src/shared/project/store.ts` | 纯 store 模型 |
| `src/shared/project/package.json` | ESM 标记 + `#project/*` 子路径导入映射 |
| `src/shared/project/yaml.ts` | 最小 YAML（原 `src/shared/yaml`，搬进 project 包以便 `#project/yaml`） |

## 7. 不可破坏的约定

1. **视觉不变**：不改 JSX class、CSS 变量、尺寸常量、窗口 chrome、默认布局顺序。
2. **不引入 DSH 的 UI/theme/layout 包**；只用 Cordis/loader/slots 等框架层。
3. **React 19 单例**：插件 bundle 外置 React，宿主通过全局提供。
4. **核心 CSS 只有一份**（shell 侧 Tailwind）；插件 CSS 尚未支持。
5. **slot 不产生包装 DOM**；`Slot` 用 `createElement`。
6. **host 不 import electron**；Electron 只能在 shell。
7. **所有新路径都要有回退**：host 直连 port 失败回退 IPC（现在也转发到 host）；
   bundle 失败回退 glob；slot 失败回退 fallback。
8. **不做 Context 模块增强**：Cordis 的 `Context` 是 re-export，会遮蔽原接口。
9. **`src/shared/project` 内的模块之间只用 `#project/*`**：`@shared/*` 是构建期别名、
   免扩展名的相对导入也一样，host 的纯 Node ESM 都解析不了。`package.json#imports`
   是 Node / tsc / Vite 三边都认的那一层（见 `src/shared/project/package.json`）。
10. **host 是必需进程**：文件 / 配置的全部实现都在它里面。打包目前靠
    `asar: false` + `files` 带上 host 源码 / boot / hello / `src/shared` / profiles；
    改回 asar 之前必须先让 host 有编译产物，否则打包版读不到自己的源码。

## 8. 踩过的坑（别再踩）

1. **Cordis Context 增强**：`declare module '@deepseek-ai/cordis' { interface Context { slots } }`
   会让 `plugin` / `effect` 全部丢失。用 `slotsOf(ctx)` / `modulesOf(ctx)` 显式取服务。
2. **Node type stripping 不支持参数属性**：`constructor(private x: string)` 会
   `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`；写成显式字段。
3. **`src/shared` 下的 .ts 被 host 直接 import**：需要在目录里放
   `package.json` `{"type":"module"}`（`src/shared/project` 与
   `src/shared/plugin-api` 都已经有），并且目录内**不能有 `@shared/*` 或免扩展名的
   相对 import** —— Node ESM 只认 `#project/*`（由同一个 package.json 的 `imports`
   映射到 `./*.ts`）。
4. **`import.meta.env.DEV` 在 alias 源码里不可靠**：loader 改用
   `window.location.protocol === 'http:'` 判断 dev。
5. **IIFE bundle**：必须 classic JSX（`React.createElement`），React 外置，
   加载时调 `__NIDE_REGISTER__`；否则 `React is not defined` / 注册不上。
6. **`/@fs/` 只在 dev**：生产会走 app 协议（TODO）；
   `loader.ts` 非 dev 会跳过并告警。
7. **`ELECTRON_RUN_AS_NODE=1`**：会让 `electron.exe` 变成 Node，`app` 为 undefined。
8. **pnpm 全局 store 锁**：agent 沙箱无法 `pnpm add`；用户终端跑。
9. **ESLint `static-components`**：动态组件用 `createElement`，别用 `<Component />`。
10. **`WorkbenchLayout` 的 flex**：slot outlet 多一层 div 就会改布局；不要加包装。
11. **`ResizeObserver` 回调链路里不要改被观察元素**：`EditorPanes` 的 `fitBodyHeight`
    曾经在 observer → state → layout effect 的同一轮里写容器高度，浏览器持续报
    `ResizeObserver loop completed with undelivered notifications`。现在的规则是高度
    重算排进下一帧、同一帧只排一次，`chapter-body` 只把宽度变化当重新布局的信号。
12. **未签名的打包 exe 会被 Windows 拦掉**：表现是双击/命令行启动后立刻返回，
    `%APPDATA%\NIDE\logs` 没有任何新行（进程根本没起来）。验证打包内容时用
    `node_modules\electron\dist\electron.exe dist\win-unpacked\resources\app`，
    它加载的是同一份 `resources/app`；发布前再解决签名。

## 9. 待定的设计问题

- 生产 bundle 协议：`nide-plugin://` vs app 协议；是否复用 `/plugins` 路由。
- 插件 CSS：禁止自带全局样式 / 提供 `@nide/ui` token / 注入约定，三选一。
- 第三方插件构建：安装时构建还是发布时预构建；pnpm 运行时怎么随包。
- `PluginSlot` 的 glob 兜底是长期保留还是删掉。
- 视觉回归工具：Playwright + Electron 截图，还是自建 `capturePage`。
- `nide.client` 的正式字段（`views` 映射？`external`？）现在只用了 `bundle`。
- **代码签名**：打包产物未签名，Windows 会直接拦 `nide.exe`。发布前需要证书
  （electron-builder `win.certificateFile` / `certificateSubjectName` + 时间戳）；
  在此之前用 `electron.exe <resources/app>` 验证打包内容。

## 10. 建议的下一会话起手式

> 先读 `docs/architecture/HANDOFF.md`、`cordis-migration.md`、`plugin-ui-bundles.md`。
> 当前状态：项目文件 / 章节 / 伏笔 / 图鉴 / 概述 / 配置的**实现只有一份**，在 host；
> 插件清单 / 启停 / 本地文件夹安装 / 卸载 / 信任确认也已接（host）。客户端 slots 与
> 运行时 bundle（dev）正常，UI 未变。打包 `asar: false` + 源码 host 已用
> `electron.exe <resources/app>` 验证过；`nide.exe` 未签名会被 SmartScreen 拦。
> **旧实现没有全部迁完**：项目 store、`src/main/plugin-host/*`（views/settings/
> locales/loader）、i18n/theme/AI/secrets、核心 UI 组件仍在 shell（见 §4.1）。
> 下一步按 §4：① 项目 store 统一 host；② 插件 views/settings/locales 迁 host；
> ③ npm 安装来源；④ 生产 bundle 协议。当前工作区可能还有未提交改动，先 commit。
> 在用户终端跑 `pnpm test` 与 `pnpm dev`（agent 沙箱起不了 vitest / electron-builder）。

## 11. 交接检查清单

- [x] `pnpm typecheck` / `pnpm typecheck:host` 绿（host 工程现在也包含
      [test/host](../../test/host) 的 8 份用例）
- [ ] `pnpm test` 重跑：最近一次 592 全绿在插件安装 / 卸载改动**之前**；
      新增的安装 / 卸载用例还没在用户终端跑过
- [x] `pnpm dev` 手工验证：从文件夹安装 → 默认禁用 → 启用信任确认 → 卸载；
      视图 / 设置树同步更新，UI 插件启用后不重启即可显示
- [x] `pnpm dev`：启动自动拉起 host；新建项目生成 `.nide` + 默认图鉴 / 概述预设
- [x] 图鉴 / 概述 / 角色图鉴 / 项目配置读路径正常
- [x] `EditorPanes` 的 ResizeObserver 修复已验证：持续刷屏消失（只剩首次布局的一条）
- [ ] `pnpm lint`：只剩 `scripts/host-ipc-node-smoke.mjs` 的两个
      `explicit-function-return-type`（迁移前就有，与本次改动无关）
- [x] `pnpm build:unpack` 通过：用 `electron.exe dist\win-unpacked\resources\app`
      启动，host ready、新建项目初始化、读写正常（当前 `asar: false` + 源码 host）
- [ ] 代码签名：`nide.exe` 未签名会被 SmartScreen 拦；发布前配 `win.certificateFile`
- [ ] `pnpm build:plugin-demo` 可重复产出 `plugins/builtin/demo/dist/client.js`
- [ ] `projects.json` 已恢复（测试欢迎窗口时改过名）
- [ ] Demo Plugin 处于启用状态（当前 `disabled:0`）
- [ ] **当前改动未提交**（插件清单 / 安装 / 卸载 / 信任 / 动态 bundle），
      建议下个会话先 commit 再开工
- [ ] `docs/wiki` 仍为空；需要用户自己 clone Wiki 仓库
