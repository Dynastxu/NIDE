# AGENTS.md — packages

`packages/` 是 NIDE 的本体：宿主运行时、业务服务、插件运行时、客户端界面与 SDK。
根目录 [AGENTS.md](../AGENTS.md) 的规则（SOLID、UX/DX/AX、git 权限）在这里同样有效；
本文件只补「包这一层」的约定。

## 布局

```
packages/
  contracts/       跨进程契约：类型 + 纯函数 + 词条基础表（不 import electron / DOM / node:fs）
  kernel/          Cordis 上下文扩展（rpc / hostEnv）、RPC 注册表与权限挂载点、shell 反桥
  boot/            profile 引导：组合 patch、ensureProfile（代码生成）、loader 启动
  host/            独立 host 进程入口（utilityProcess 的 Node 侧）：装配、IPC、退出
  shell/           Electron 外壳：main（窗口 / 菜单 / 对话框 / 协议）+ preload
  project/ content/ config/ plugin-runtime/ i18n/ appearance/ secrets/ ai/   宿主业务，一包一个
  plugins/<name>/  NIDE 插件包（manifest + 贡献点 + 可选后端 / 客户端 bundle）
  sdk/             插件开发者 API：视图渲染管线、useHost
  client-kit/      客户端平台层：stores / 基础 UI / 窗口外壳 / logger / monaco
  client-runtime/  客户端 Cordis 树 + slot + bundle loader + 生成的花名册
  client-ui-*/     三个窗口的界面包（main / layout / welcome / settings 等）
  client-modules/  插件客户端 bundle 的注册表与加载
  client-ui-slots/ slot 注册表
  hello/           最小 Cordis 插件（冒烟用）
```

## 依赖方向

- 宿主侧：`contracts ← kernel ← 业务包/plugin-runtime ← boot/host ← shell`；
- 客户端：`contracts ← client-kit ← sdk ← client-ui-* ← client-runtime`；
- **反向 import 视为设计错误**；`contracts` 不得 import 任何包，也不得碰 Electron / DOM / 文件系统；
- 业务包之间不互相 import 实现，一律通过 `ctx.<service>`（`inject` 声明）。

## import 约定

- **host 侧（boot / host / kernel / 业务包 / plugin-runtime）**：纯 Node ESM，用带 `.ts`
  扩展名的相对路径；**不要**用 `@nide/*` 别名（打包产物没有别名解析），也不要 import
  宿主入口；
- **客户端（client-* / sdk / test/renderer）**：用 `@nide/*` 别名（`tsconfig.web`、
  `electron.vite.config.ts`、`vitest.config.ts` 三处必须保持一致），包内可用
  `@nide/client-kit/...` 这类子路径；
- 新增别名时三处一起改，否则 `typecheck` / 构建 / 测试会各绿各的。

## 服务与插件

- 服务是普通 Cordis 插件：`export default { name, inject, apply(ctx) }`，在 `apply` 里
  `ctx.provide('x', value)`；类型用 `packages/host/src/service-types.ts` 的
  `declare module 'cordis'` 合并；
- 加一个服务 = 新包 + `packages/bundle/base/cordis.patch.yml` 一行（`core: true`），
  不写装配代码；
- `packages/plugins/*` 是 NIDE 插件包：`manifest.json` 是数据，入口 `apply` 里调用
  `ctx.plugins.registerPackage(manifest, dir)`；插件只能依赖 `sdk`；
- 客户端界面包必须声明 `nide.client.windowTypes` 并导出 `clientPlugins`，随后跑
  `pnpm gen:client-roster`；不要手写窗口 → 包的表。

## 构建与测试

- `pnpm typecheck`（node + web）、`pnpm typecheck:host`、`pnpm lint`、`pnpm test` 是门禁；
- `pnpm build:host` 从 YAML 里的 `{{NIDE_ROOT}}/...` 收集动态入口；新增「只被行引用、
  不被静态 import」的入口时，同步 `scripts/build-host.mts`；
- 测试按 `test/{main,shared,host,renderer}` 分家：一个用例只能 import 它所在 tsconfig
  覆盖的文件，跨工程请补对应 tsconfig；
- 测试用临时目录，不写仓库、不依赖网络。

## 文档

- 架构与边界写在 `docs/architecture/`；改动契约、权限、插件协议、装配方式时同步更新；
- 根 README 只放项目说明与上手，细节不要往回抄。
