# AGENTS.md — packages

`packages/` 是 NIDE 的本体：宿主运行时、业务服务、插件运行时、客户端界面与 SDK。
根目录 [AGENTS.md](../AGENTS.md) 的规则（SOLID、DX/AX、git 权限）在这里同样有效；
本文件只补「包这一层」的约定。

## 布局

目录按**层**分组，不按「哪次迁移搬了谁」分组。同一层里的包可以互相理解，跨层只能
按下面的表依赖。

```
packages/
  contracts/        契约层：类型 + 纯函数 + 词条基础表 + 端口/领域错误（不 import 任何包）
  kernel/           内核：Cordis 上下文扩展（rpc / hostEnv）、RPC 注册表与权限挂载点、shell 反桥
  project/ content/ config/ i18n/ appearance/ secrets/ ai/ plugin-runtime/
  plugin-backend/ plugin-storage/ plugin-permissions/ plugin-capabilities/
                    宿主业务服务：一包一个业务域，彼此只走 ctx.<service>
  boot/ host/       装配：profile 引导（ensureProfile / loader）与 host 进程入口
  shell/            Electron 外壳：main（窗口 / 菜单 / 对话框 / 协议）+ preload
  plugins/<name>/   插件包：manifest + 贡献点 + 可选后端 / 客户端 bundle
                           ── 以上是宿主侧（纯 Node ESM）──
  client-kit/       客户端平台层：基础 UI / 窗口外壳 / logger / monaco（不放任何窗口的领域状态）
  sdk/              插件开发者 API：useHost / 受限宿主 API / 插件词条上下文
  client-ui-slots/ client-modules/ client-ui-renderer/
                    客户端接缝：slot 注册表、模块表 + bundle 加载、渲染管线
                    （React 绑定 / PluginSlot / 视图外壳 ViewFrame；**不是窗口**）
  client-ui-plugins/
                    客户端功能包：设置与欢迎窗口共用的插件管理界面（**不是窗口**）
  client-ui-main/ client-ui-settings/ client-ui-welcome/
                    客户端窗口：一个包 = 一扇窗的界面（声明 nide.client.windowTypes）
  client-runtime/   客户端树：按 windowType 挂载窗口包 + 生成的花名册（**只做装配**）
  hello/            最小 Cordis 插件（冒烟用）
```

切法对齐 DSH：**包按能力 / 角色切，共享面只有「库」**。窗口与功能包是装配出来的
东西，不是共享层；共享代码要么进库（`client-kit` / `client-ui-renderer` /
`client-ui-slots` / `client-modules`），要么进 `contracts`。

## 包类型与允许的依赖

| 类型            | 包                                                                                                                                                            | 允许依赖                                                           | 一个包只装                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| contract        | `contracts`                                                                                                                                                   | 无（连 `import type` 也不行）                                      | 形状、纯函数、词条基础表、端口与领域错误    |
| kernel          | `kernel`                                                                                                                                                      | contract                                                           | ctx 扩展、RPC 表、反向桥                    |
| service         | `project` `content` `config` `i18n` `appearance` `secrets` `ai` `plugin-runtime` `plugin-backend` `plugin-storage` `plugin-permissions` `plugin-capabilities` | contract, kernel                                                   | 一个业务域；服务之间只走 `ctx.<service>`    |
| bootstrap       | `boot` `host`                                                                                                                                                 | contract, kernel, service, bootstrap, hello                        | 装配与进程入口                              |
| shell           | `shell`                                                                                                                                                       | contract                                                           | 只有 Electron 才能做的事                    |
| client-platform | `client-kit`                                                                                                                                                  | contract                                                           | 三扇窗共用的 UI / 外壳 / logger / monaco    |
| client-sdk      | `sdk`                                                                                                                                                         | contract, client-platform                                          | 插件作者看到的 API                          |
| client-seam     | `client-ui-slots` `client-modules` `client-ui-renderer`                                                                                                       | contract, client-platform, client-sdk, client-seam                 | slot 注册表、模块表 + bundle 加载、渲染管线 |
| client-feature  | `client-ui-plugins`                                                                                                                                           | contract, client-platform, client-sdk, client-seam                 | 跨窗口共用的功能界面                        |
| client-window   | `client-ui-main` `client-ui-settings` `client-ui-welcome`                                                                                                     | contract, client-platform, client-sdk, client-seam, client-feature | 一扇窗的界面与领域状态；窗口根与自己的 slot |
| client-runtime  | `client-runtime`                                                                                                                                              | 上面所有客户端层                                                   | 只做装配                                    |
| plugin          | `plugins/*`                                                                                                                                                   | contract, client-platform, client-sdk, client-seam                 | manifest + 贡献点                           |
| smoke           | `hello`                                                                                                                                                       | 无                                                                 | 冒烟                                        |

四条硬规则：

1. **新包必须同时登记两处**：`scripts/check-imports.mts` 的 `LAYER_OF` 与本表。漏一处
   `pnpm lint:imports` 直接报「未分类的包」。
2. **`import type` 不产生运行时 / 打包耦合**，可以跨层 —— 只有 `contracts` 例外，
   它连类型也不许指向别的包，否则「契约层」就变成了又一个共享层。
3. **业务包之间只有两条路**：走 `ctx.<service>`，或把纯函数 / 端口 / 领域错误搬进
   `contracts`。不要再 import 另一个业务包的实现（`content -> config`、`ai -> secrets`
   两条已于 2026-11-18 修掉）。
4. **插件只能用「库」，不能用「窗口」**：`client-kit` / `client-ui-slots` /
   `client-ui-renderer` 是库（基础控件、视图外壳、渲染机械），插件可以 import；
   `client-ui-main` 这类窗口包、`client-ui-plugins` 这类功能包不行 —— 那会把宿主
   窗口的改动直接变成插件的 break。插件需要新能力时，先补进库或 `sdk`。

## 门禁

```bash
pnpm lint:imports   # 包依赖：分层规则 + 未分类包 + contracts 自包含 + 依赖环
pnpm check          # typecheck + lint:imports + lint + test
```

- 存量违规写在脚本的 `KNOWN` 数组里（**只许删不许加**），每条都带原因；修掉一条就把
  那一行删掉，脚本会报「基线已过期」提醒你。当前基线是 **0 条**。
- 新增依赖环一律报错；已知环只有在经过基线里的边时才放行，所以环不会悄悄变多。

## import 约定

- **host 侧（boot / host / kernel / 业务包 / plugin-runtime）**：纯 Node ESM，用带 `.ts`
  扩展名的相对路径；**不要**用 `@nide/*` 别名（打包产物没有别名解析），也不要 import
  宿主入口；
- **客户端（`client-*` / `sdk` / `test/renderer`）**：用 `@nide/*` 别名（`tsconfig.web`、
  `electron.vite.config.ts`、`vitest.config.ts`、`scripts/build-plugin-client.mjs`
  四处必须保持一致），包内可用 `@nide/client-kit/...` 这类子路径；
- 新增别名时四处一起改，否则 `typecheck` / 构建 / 插件 bundle / 测试会各绿各的。

## 服务与插件

- 服务是普通 Cordis 插件：`export default { name, inject, apply(ctx) }`，在 `apply` 里
  `ctx.provide('x', value)`；类型用 `packages/host/src/service-types.ts` 的
  `declare module 'cordis'` 合并；
- 加一个服务 = 新包 + `packages/bundle/base/cordis.patch.yml` 一行（`core: true`），
  不写装配代码；
- `packages/plugins/*` 是 NIDE 插件包：`manifest.json` 是数据，入口 `apply` 里调用
  `ctx.plugins.registerPackage(manifest, dir)`；插件 UI 只依赖库（见硬规则 4）；
- 客户端**窗口**包必须声明 `nide.client.windowTypes` 并导出 `clientPlugins`，随后跑
  `pnpm gen:client-roster`；功能包 / 库包不要声明 `nide.client`，否则会被当成窗口挂载。

## 构建与测试

- `pnpm typecheck`（node + web）、`pnpm typecheck:host`、`pnpm lint`、`pnpm lint:imports`、
  `pnpm test` 是门禁（`pnpm check` 已串起来）；
- `pnpm build:host` 从 YAML 里的 `{{NIDE_ROOT}}/...` 收集动态入口；新增「只被行引用、
  不被静态 import」的入口时，同步 `scripts/build-host.mts`；
- 测试按 `test/{main,shared,host,renderer}` 分家：一个用例只能 import 它所在 tsconfig
  覆盖的文件，跨工程请补对应 tsconfig；
- 测试用临时目录，不写仓库、不依赖网络。

## 文档

- 架构与边界写在 `docs/architecture/`；改动契约、权限、插件协议、装配方式时同步更新；
- 根 README 只放项目说明与上手，细节不要往回抄。
