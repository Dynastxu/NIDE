# NIDE 迁移交接（2026-10-25）

> 新会话先读这份，再读 [cordis-migration.md](cordis-migration.md) 与
> [plugin-ui-bundles.md](plugin-ui-bundles.md)。三份都是当前有效的约定，不是历史记录。

## 0. 一句话状态

Cordis/DSH 架构的**竖切已经跑通**：Electron shell → 独立 host 进程 → 通用 RPC →
客户端 Cordis 树 → slot → 运行时插件 UI bundle。现有界面外观未改，旧路径都保留了
回退。剩余工作是横向铺业务、插件管理器和生产化，不是重新验证架构。

**所有改动都还在工作区，没有 commit。**

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
└─ 项目配置（services/project-config.ts）：load / update / registry / resolve /
   remapOverviewRole

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
- 第三批（未提交）：删掉主进程两份服务实现，旧 IPC handler 改成**转发**到 host；
  `config.initialize` 由 shell 经父端口 RPC（`invokeHost`）调用；host 变成启动必需；
  8 份服务测试从 `test/main/services` 搬到 [test/host](../../test/host)，由
  `tsconfig.host.json` 一起 typecheck。代码净删约 4300 行。
- `pnpm test` 会跑 `test/host/**`，`pnpm typecheck:host` 同时检查 host 与这些用例。

## 4. 未完成 / 下一步优先级

1. **收尾 host 化 / 打包**：重复实现已删、测试已切到 host。打包先走最小可用路线：
   - `electron-builder.yml` **不启用 asar**，host 继续跑源码 `.ts`（Electron 的 Node
     做类型剥离）；`files` 里显式带上 `packages/host|boot|hello`、`src/shared`、
     `profiles`、`plugins`。`resolveHostEntry()` 在 dev 与打包版都指向 app 根下的
     `packages/host/src/index.ts`，所以两者布局一致。
   - 已验证：`pnpm build:unpack` 产物用
     `node_modules\electron\dist\electron.exe dist\win-unpacked\resources\app` 启动正常
     （host ready、新建项目初始化、文件读写都通过）。直接运行 `nide.exe` 会被
     SmartScreen 按「未签名」拦掉 —— 那是发布问题，不是打包内容问题；正式分发前
     要配代码签名。
   - 之后才是「编译 host + 恢复 asar」：那时 profile 里的 `{{NIDE_ROOT}}/...` 要换成
     包标识符或 resources 路径，`files` 也会缩到编译产物。不要在没有验证的情况下
     先开 asar —— host 读不到自己的源码，文件功能会整块失效。
   - **回退链**：preload 的旧 IPC 通道现在也转发到 host；等打包验证过、直连 port
     足够稳定后可以删掉这一层，只留 `host:project-confirm-delete`。
2. **插件管理器**：安装/卸载/启停、写 profile patch、第三方 bundle、信任确认。
3. **生产 bundle 链路**：`nide-plugin://` 或 app 协议、批量构建、CSS 约定、HMR。
4. **Profile / loader 完整语义**：bundle 组合、`cordis.patch.yml`、`!!js`、
   required 审计、runtime resolution。
5. **视觉回归 + 打包**：截图基线、`build:win`、asar/host 入口、pnpm 运行时。
6. **删旧系统**：`src/main/plugin-host`、`src/shared/plugin-api`（逐步）、
   `PluginSlot` 的 glob 兜底、settings 页面的旧加载。

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
   `package.json` `{"type":"module"}`（`src/shared/project/package.json` 就是为此），
   并且目录内**不能有 `@shared/*` 或免扩展名的相对 import** —— Node ESM 只认
   `#project/*`（由同一个 package.json 的 `imports` 映射到 `./*.ts`）。
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
> 当前状态：文件 / 章节 / 伏笔 / 图鉴 / 概述 / 项目配置的**实现只有一份**，在 host；
> shell 只剩项目列表、窗口、对话框、确认框，以及转发旧 IPC 的薄层。host 启动必需。
> 打包已配好「asar: false + host 跑源码」，`build:unpack` 产物已用
> `electron.exe <resources/app>` 验证通过。`nide.exe` 未签名会被 SmartScreen 拦，
> 那是发布/签名问题，不影响打包内容。
> 下一步做**插件管理器**：安装 / 卸载 / 启停、写 profile patch、第三方 bundle、
> 信任确认；代码签名与「编译 host + 恢复 asar」留到发布前。
> 在用户终端跑 `pnpm test` 与 `pnpm dev`（agent 沙箱起不了 vitest / electron-builder）。

## 11. 交接检查清单

- [x] `pnpm typecheck` / `pnpm typecheck:host` 绿（host 工程现在也包含
      [test/host](../../test/host) 的 8 份用例）
- [ ] `pnpm test` 重跑：第三批（删服务、测试搬到 test/host、host 必需）之后还没跑
- [ ] `pnpm dev` 重跑：现在不再需要 `NIDE_HOST`；重点看启动是否自动拉起 host、
      新建项目是否生成 `.nide` + 默认图鉴 / 概述预设（走 `config.initialize`）
- [ ] 手动点一遍图鉴 / 概述 / 角色图鉴 / 项目配置，确认读路径正常
- [x] `EditorPanes` 的 ResizeObserver 修复已验证：持续刷屏消失（只剩首次布局的一条）
- [ ] `pnpm lint`：只剩 `scripts/host-ipc-node-smoke.mjs` 的两个
      `explicit-function-return-type`（迁移前就有，与本次改动无关）
- [x] `pnpm build:unpack` 通过：用 `electron.exe dist\win-unpacked\resources\app`
      启动，host ready、新建项目初始化、读写正常（当前 `asar: false` + 源码 host）
- [ ] 代码签名：`nide.exe` 未签名会被 SmartScreen 拦；发布前配 `win.certificateFile`
- [ ] `pnpm build:plugin-demo` 可重复产出 `plugins/builtin/demo/dist/client.js`
- [ ] `projects.json` 已恢复（测试欢迎窗口时改过名）
- [ ] Demo Plugin 处于启用状态（当前 `disabled:0`）
- [ ] 决定是否先 commit / 开分支（当前全部未提交）
- [ ] `docs/wiki` 仍为空；需要用户自己 clone Wiki 仓库
