# AGENTS.md — packages

`packages/` 是 NIDE 的本体：宿主运行时、业务服务、插件运行时、客户端界面与 SDK。
根目录 [AGENTS.md](../AGENTS.md) 的规则（SOLID、DX/AX、git 权限）在这里同样有效；
本文件只补「包这一层」的约定。

## 布局

目录按**层**分组，不按「哪次迁移搬了谁」分组。同一层里的包可以互相理解，跨层只能
按下面的表依赖。

```
packages/
  domain/           共享领域规则（纯逻辑）：项目结构 / 配置文本 / 章节·伏笔·图鉴·概述 / 文件树
                    （不 import 任何包，也不碰 Electron / DOM / fs）
  contracts/        跨进程契约：线格式 + 词条基础表 + 端口/领域错误（不 import 任何包）
  kernel/           内核：Cordis 上下文扩展（rpc / hostEnv）、RPC 注册表与权限挂载点、shell 反桥
  project/ content/ config/ i18n/ appearance/ secrets/ ai/ plugin-runtime/
  plugin-backend/ plugin-storage/ plugin-permissions/ plugin-capabilities/
                    宿主业务服务：一包一个业务域，彼此只走 ctx.<service>
  boot/ host/       装配：profile 引导（ensureProfile / loader）与 host 进程入口
  shell/            Electron 外壳：main（窗口 / 菜单 / 对话框 / 协议）+ preload
  plugins/<name>/   插件包：manifest + 贡献点 + 可选后端 / 客户端 bundle
                           ── 以上是宿主侧（纯 Node ESM）──
  client-kit/       客户端平台层：基础 UI / 窗口外壳 / logger / monaco / workbench 文档状态
                    （layout / documents；不放某个窗口专属的业务状态）
  sdk/              插件开发者 API：useHost / 受限宿主 API / 插件词条上下文
  client-ui-slots/ client-modules/ client-ui-renderer/
                    客户端接缝：slot 注册表、模块表 + bundle 加载、渲染管线
                    （React 绑定 / PluginSlot / 视图外壳 ViewFrame；**不是窗口**）
  client-ui-plugins/ client-ui-explorer/ client-ui-editor/ client-ui-git/
                    客户端功能包：窗口内 / 跨窗口的功能界面（只注册子 slot，不注册窗口根）
  client-ui-main/ client-ui-settings/ client-ui-welcome/
                    客户端窗口：一个包 = 一扇窗的外壳与领域状态（分区 + 窗口根 + 自己的 slot）
  client-runtime/   客户端树：按 windowType 挂载窗口包 + 生成的花名册（**只做装配**）
  hello/            最小 Cordis 插件（冒烟用）

apps/desktop/       渲染进程引导壳（workspace 包；main / preload 在 packages/shell）
```

切法对齐 DSH：**包按能力 / 角色切，共享面只有「库」**。窗口与功能包是装配出来的
东西，不是共享层；共享代码要么进库（`client-kit` / `client-ui-renderer` /
`client-ui-slots` / `client-modules`），要么进 `domain`（纯规则）/ `contracts`（线格式）。

窗口包只定义**分区与窗口根**；具体视图由功能包把组件注册到 `hostViewSlotName(id)`
这样的 slot 上（`client-ui-git` → 版本控制 / 提交）。窗口包不 import 功能包的视图
组件 —— 那是「窗口知道所有功能」的中央装配，加一个视图就要改窗口。

## 包类型与允许的依赖

**每个包属于哪一层，由它自己的 `package.json` 声明**：`"nide": { "layer": "<层>" }`
（与 `nide.bundle` / `nide.plugin` / `nide.client` 同一套元数据）。当前每个包分别在哪一层、
实际的边是怎么连的，见生成物 [package-graph.md](../docs/architecture/package-graph.md)
——不要在这份文件里抄一份包清单。

两条纯层的规则：`domain` 谁都可以 import（它是根），但它自己什么都不 import；
`contracts` 同样不 import 任何包 —— 区别只在内容：契约描述**跨进程传什么**，
领域规则是 host 与渲染进程各自要**算**的纯逻辑。两个纯层都不许碰 Node / Electron /
DOM / fs。

| 类型            | 允许依赖（省略 domain：它谁都能用）                                | 一个包只装                                                    |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| domain          | 无                                                                 | 共享领域规则：纯函数、数据表、解析 / 序列化                   |
| contract        | 无（连 `import type` 也不行）                                      | 跨进程线格式、词条基础表、端口与领域错误                      |
| kernel          | contract                                                           | ctx 扩展、RPC 表、反向桥                                      |
| service         | contract, kernel                                                   | 一个业务域；服务之间只走 `ctx.<service>`                      |
| bootstrap       | contract, kernel, service, bootstrap, hello                        | 装配与进程入口                                                |
| shell           | contract                                                           | 只有 Electron 才能做的事                                      |
| client-platform | contract                                                           | 三扇窗共用的 UI / 外壳 / logger / monaco / workbench 文档状态 |
| client-sdk      | contract, client-platform                                          | 插件作者看到的 API                                            |
| client-seam     | contract, client-platform, client-sdk, client-seam                 | slot 注册表、模块表 + bundle 加载、渲染管线                   |
| client-feature  | contract, client-platform, client-sdk, client-seam                 | 功能界面：注册到窗口 slot（可跨窗口共用），不注册窗口根       |
| client-window   | contract, client-platform, client-sdk, client-seam, client-feature | 一扇窗的外壳与领域状态：分区 / 窗口根 / 自己的 slot           |
| client-runtime  | 上面所有客户端层                                                   | 只做装配                                                      |
| plugin          | contract, client-platform, client-sdk, client-seam                 | manifest + 贡献点                                             |
| bundle          | 无                                                                 | 组合包：只有 manifest 与 patch，没有代码                      |
| smoke           | 无                                                                 | 冒烟                                                          |
| app             | 上面所有客户端层                                                   | 渲染进程引导壳（`apps/desktop`，workspace 包，不发布）        |

四条硬规则：

1. **新包 = 目录 + `package.json`（`name` / `exports` / `nide.layer` / 依赖）**，然后跑
   `pnpm gen:package-graph`。少声明层，`pnpm lint:imports` 直接报「包 X 没有声明层」；
   跨包 import 了却没写进自己的 `dependencies`，同一个门禁报「没有声明依赖」。
   `exports` 至少覆盖 `./* → ./src/*`，有根入口时再加 `"."`。
2. **`import type` 不产生运行时 / 打包耦合**，可以跨层 —— 两个纯层例外（`contracts`
   什么都不 import，`domain` 也什么都不 import），否则纯层就变成了又一个共享层。
3. **业务包之间只有两条路**：走 `ctx.<service>`，或把纯函数 / 端口 / 领域错误搬进
   `domain`（纯规则）与 `contracts`（线格式）。不要再 import 另一个业务包的实现
   （`content -> config`、`ai -> secrets` 两条已于 2026-11-18 修掉）。
4. **插件只能用「库」，不能用「窗口」**：`client-kit` / `client-ui-slots` /
   `client-ui-renderer` 是库（基础控件、视图外壳、渲染机械），插件可以 import；
   `client-ui-main` 这类窗口包、`client-ui-plugins` 这类功能包不行 —— 那会把宿主
   窗口的改动直接变成插件的 break。插件需要新能力时，先补进库或 `sdk`。

## 门禁

```bash
pnpm lint:imports        # 包依赖：分层规则 + 未声明层 / 未声明依赖 + 跨包相对导入 + 纯层自包含 + 依赖环
pnpm lint:domains        # 包内域分层：窗口 / 功能包内部跨域只能经 shared / 装配点
pnpm gen:package-graph   # 重新生成 docs/architecture/package-graph.md（改依赖后必跑）
pnpm graph:check         # 只校验生成图是否最新（CI 用）
pnpm check               # typecheck + lint:imports + lint:domains + graph:check + lint + test
```

- 包间门禁的存量违规写在 `scripts/check-imports.mts` 的 `KNOWN` 里（**只许删不许加**），
  每条都带原因；修掉一条就把那一行删掉，脚本会报「基线已过期」。当前基线是 **0 条**。
- 新增依赖环一律报错；已知环只有在经过基线里的边时才放行，所以环不会悄悄变多。

## 包内分层（窗口 / 功能包）

一个窗口包内部按域分目录（`editor/` `explorer/` `entry/` `layout/` …），规则与 DSH 一致：

- **共享目录**（`shared/`、`stores/`）谁都能 import；
- **域之间不许互相 import**，跨域只能出现在装配点（`index` / `App` / `MainApp`，以及
  声明为装配域的 `layout` / `host-view`）；
- 只算运行时 import（`import type` 不算）；
- 受约束的包与每包配置在 `scripts/check-package-domains.mts`；存量跨域进它自己的
  `KNOWN`（只许删不许加），修一条删一行。

这样「改编辑器」不会顺手把文件树也拖下水，单个域也能整体搬走。

客户端 slot 的模型（`single` / `keyed` / `list`、声明、订阅、快照）见
[docs/architecture/client-slots.md](../docs/architecture/client-slots.md)。窗口声明槽，
功能包注册 occupant；窗口不 import 功能包的组件。

explorer / editor 共用的文档状态在 `client-kit/stores/documents.store`（打开 / 活跃 /
脏标记 / 关闭队列），图鉴 / 概述目录缓存在 `client-kit/stores/gallery.store` 与
`overview.store`；保存后的通知在 `documents-events`，客户端服务面是 `ctx.documents`。
功能包都依赖 kit，不要互相 import store；细节见
[docs/architecture/client-documents.md](../docs/architecture/client-documents.md)。

## import 约定

- **跨包一律用包名**：`@nide/<包>/<子路径>`。包名看目标包的 `package.json`，不一定等于
  目录名（`packages/plugin-runtime` 是 `@nide/service-plugins`）。**不要**写
  `../../kernel/src/...` 或 `../../../packages/contracts/src/...`：包边界不能只靠目录。
  包内文件之间仍然用相对路径。
- **host 侧（boot / host / kernel / 业务包 / plugin-runtime）**：纯 Node ESM，包名后带
  `.ts` 子路径（`@nide/kernel/context.ts`）。`pnpm build:host` 发射时会把包名改写成
  相对 `.js`，并把第三方依赖闭包复制到 `out/host/node_modules`（见
  `scripts/build-host.mts`）。
- **客户端（`client-*` / `sdk` / `test/renderer`）**：包名后不带扩展名
  （`@nide/client-kit/stores/documents.store`），由 Vite 别名解析。`tsconfig.web`、
  `electron.vite.config.ts`、`vitest.config.ts`、`scripts/build-plugin-client.mjs`
  四处必须保持一致；新增客户端包时四处一起改。
- **每个包的 `exports` 暴露源码**：`"./*": "./src/*"`；有根入口时再加 `"."`。
  **依赖写在自己的 `package.json`**（workspace 包用 `workspace:*`）。根
  `@nide/nide-root` 不声明 `dependencies`，只保留工具链 `devDependencies`：
  `pnpm build:host` 把 host 的运行时依赖闭包复制到 `out/host/node_modules`，
  main / preload 由 electron-vite 打进 bundle。
  `pnpm lint:imports` 会拦「跨包相对导入」和「没声明依赖」。

## 服务与插件

- 服务是普通 Cordis 插件：`export default { name, inject, apply(ctx) }`，在 `apply` 里
  `ctx.provide('x', value)`；类型用 `packages/host/src/service-types.ts` 的
  `declare module 'cordis'` 合并；
- 加一个服务 = 新包 + `packages/bundle/base/cordis.patch.yml` 一行（`core: true`），
  不写装配代码；
- `packages/plugins/*` 是 NIDE 插件包：`manifest.json` 是数据，入口 `apply` 里调用
  `ctx.plugins.registerPackage(manifest, dir)`；插件 UI 只依赖库（见硬规则 4）；
- 客户端包用 `nide.client.windowTypes` 声明挂到哪些窗口，并导出 `clientPlugins`，随后跑
  `pnpm gen:client-roster`；**窗口包**还要注册 `<window>.root`，**功能包**只注册自己负责
  的子 slot（例如 `client-ui-git` 注册 `view.host.git` / `view.host.commit`）。库包不要
  声明 `nide.client`，否则会被花名册当成可挂载的客户端插件。

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
