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
├─ utilityProcess.fork(packages/host/src/index.ts)   ← NIDE_HOST=1
└─ 建窗时 MessageChannelMain：一个 port 给 host，一个给 renderer

Host（packages/host，纯 Node ESM）
├─ Cordis root + loader + profile（packages/boot）
├─ RpcRegistry（host/src/rpc.ts）
├─ HostProjectStore（project.list / setCurrent / startup）
└─ readProjectDir / readProjectFile / writeProjectFile /
   createProjectEntry / renameProjectEntry / deleteProjectEntry

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
- `NIDE_HOST=1` 时 `src/main/host/process.ts` 用 `utilityProcess.fork` 拉起 host；
- 等 `{type:'ready'}`，支持 ping/pong、shutdown、超时 kill；
- host 入口 `packages/host/src/index.ts`：Cordis `Context` + loader + 插件；
- 生命周期日志：`host process is ready`、`host ready ... ipc=true`。

### RPC 与宿主业务
- 协议：`src/shared/host-rpc/index.ts`；host 分发：`packages/host/src/rpc.ts`；
- namespace：`host.info`、`project.list/current/startup/setCurrent`、
  `files.readDir/readFile/writeFile/createEntry/renameEntry/deleteEntry`；
- preload 暴露 `window.nideHost.invoke(ns, method, ...args)`；
- preload 的 `projects.list/readDir/readFile/writeFile/createEntry/renameEntry/deleteEntry`
  已 host 优先、失败回退旧 IPC；
- 删除的二次确认留在 shell（host 没有窗口）：preload 先走
  `host:project-confirm-delete` 问一句，用户同意后再调 host；
- 改名的后续动作也留在 shell：host 改名成功后 preload 调
  `host:project-overview-remap`，把 `.nide/config.yml` 里的大纲 / 写作风格映射跟着改
  （配置服务还没搬进 host）；
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
- `pnpm test`：35 files / 583 tests 全绿（2026-10-26，用户终端）。此前那条失败是
  `host-channels.test.ts` 漏了 `getClientBundles`，已补。
- `NIDE_HOST=1 pnpm dev` 已验证：新建 / 改名 / 删除的日志全部来自 `[nide-host]`，
  没有回退到旧 IPC；删除确认框仍在 shell 弹出。

## 4. 未完成 / 下一步优先级

1. **宿主读路径第二批**：`readChapters` / `readForeshadowing` / config / gallery / overview。
   写路径（`createEntry` / `renameEntry` / `deleteEntry`）已搬完，旧实现仍留作回退；
   全部搬完后删 `src/main/services/project-files.service.ts` 的重复实现与旧 handler，
   并把 `host:project-confirm-delete` / `host:project-overview-remap` 两条过渡通道
   并回 host（配置服务搬过去之后）。
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
$env:NIDE_HOST='1'
pnpm dev
```

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
| `src/main/host/process.ts` | spawn host、ready、attach port、stop |
| `src/main/index.ts` | `NIDE_HOST=1` 时启动 host；`browser-window-created` 挂 port；`will-quit` 停 host |
| `src/main/ipc/host.ipc.ts` | 旧 IPC 门面 + `host:get-client-bundles` |
| `src/preload/index.ts` | `nideHost` 桥、host 优先回退、`__NIDE_BOOT__` |
| `src/shared/host-rpc/index.ts` | RPC 协议 |
| `packages/host/src/rpc.ts` | RpcRegistry |
| `packages/host/src/services/project-store.ts` | host 项目列表 / 当前项目 |
| `packages/host/src/services/project-files.ts` | host 读/写文件 |
| `packages/client-runtime/src/index.ts` | 客户端树、slots/modules、bundle 加载 |
| `packages/client-runtime/src/loader.ts` | `/@fs/` IIFE 注入 |
| `packages/client-ui-slots/src/index.ts` | `SlotRegistry` / `slotsOf` |
| `packages/client-modules/src/index.ts` | `ClientModuleRegistry` / `modulesOf` |
| `packages/client-ui-renderer/src/index.tsx` | `<SlotProvider>` / `<Slot>` |
| `src/renderer/src/plugins/PluginSlot.tsx` | 先查注册表，再回退 glob |
| `plugins/builtin/demo/src/ui/client-entry.tsx` | bundle 入口 |
| `scripts/build-plugin-client.mjs` | IIFE 构建 |
| `src/shared/project/store.ts` | 纯 store 模型；`src/shared/project/package.json` 是 ESM 标记 |

## 7. 不可破坏的约定

1. **视觉不变**：不改 JSX class、CSS 变量、尺寸常量、窗口 chrome、默认布局顺序。
2. **不引入 DSH 的 UI/theme/layout 包**；只用 Cordis/loader/slots 等框架层。
3. **React 19 单例**：插件 bundle 外置 React，宿主通过全局提供。
4. **核心 CSS 只有一份**（shell 侧 Tailwind）；插件 CSS 尚未支持。
5. **slot 不产生包装 DOM**；`Slot` 用 `createElement`。
6. **host 不 import electron**；Electron 只能在 shell。
7. **所有新路径都要有回退**：host 失败回退 IPC；bundle 失败回退 glob；slot 失败回退 fallback。
8. **不做 Context 模块增强**：Cordis 的 `Context` 是 re-export，会遮蔽原接口。

## 8. 踩过的坑（别再踩）

1. **Cordis Context 增强**：`declare module '@deepseek-ai/cordis' { interface Context { slots } }`
   会让 `plugin` / `effect` 全部丢失。用 `slotsOf(ctx)` / `modulesOf(ctx)` 显式取服务。
2. **Node type stripping 不支持参数属性**：`constructor(private x: string)` 会
   `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`；写成显式字段。
3. **`src/shared` 下的 .ts 被 host 直接 import**：需要在目录里放
   `package.json` `{"type":"module"}`（`src/shared/project/package.json` 就是为此）。
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

## 9. 待定的设计问题

- 生产 bundle 协议：`nide-plugin://` vs app 协议；是否复用 `/plugins` 路由。
- 插件 CSS：禁止自带全局样式 / 提供 `@nide/ui` token / 注入约定，三选一。
- 第三方插件构建：安装时构建还是发布时预构建；pnpm 运行时怎么随包。
- `PluginSlot` 的 glob 兜底是长期保留还是删掉。
- 视觉回归工具：Playwright + Electron 截图，还是自建 `capturePage`。
- `nide.client` 的正式字段（`views` 映射？`external`？）现在只用了 `bundle`。

## 10. 建议的下一会话起手式

> 先读 `docs/architecture/HANDOFF.md`、`cordis-migration.md`、`plugin-ui-bundles.md`。
> 当前状态：host 竖切 + client slots + demo 运行时 bundle 已通，UI 未变；
> 文件读、保存、新建、改名、删除都已 host 优先。
> 下一步做「宿主读路径第二批」：`readChapters` / `readForeshadowing` / config /
> gallery / overview 搬进 `packages/host/src/services/`，注册对应 `files.*` /
> `project.*`，preload host 优先、失败回退；搬完删主进程的重复实现与旧 handler。
> 在用户终端跑 `pnpm test`（agent 沙箱起不了 vitest 的 esbuild）。

## 11. 交接检查清单

- [x] `pnpm typecheck` / `pnpm typecheck:host` 绿（`tsconfig.host` 已收窄到
      `packages/host|boot|hello`，不再把 client 包拖进 NodeNext 工程）
- [x] `pnpm test`：35 files / 583 tests 全绿（2026-10-26，用户终端）
- [x] `NIDE_HOST=1 pnpm dev`：新建 / 改名 / 删除均由 host 处理，无回退日志
- [ ] `pnpm lint`：只剩 `scripts/host-ipc-node-smoke.mjs` 的两个
      `explicit-function-return-type`（迁移前就有，与本次改动无关）
- [ ] `pnpm build:plugin-demo` 可重复产出 `plugins/builtin/demo/dist/client.js`
- [ ] `projects.json` 已恢复（测试欢迎窗口时改过名）
- [ ] Demo Plugin 处于启用状态（当前 `disabled:0`）
- [ ] 决定是否先 commit / 开分支（当前全部未提交）
- [ ] `docs/wiki` 仍为空；需要用户自己 clone Wiki 仓库
