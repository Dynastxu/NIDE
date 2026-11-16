# 走向「一切皆插件」的目录结构

> 这份文档只讲**结构**：现在的目录为什么难读、目标长什么样、按什么顺序改。
> 功能细节看 [HANDOFF.md](HANDOFF.md)，渲染侧 bundle 看
> [plugin-ui-bundles.md](plugin-ui-bundles.md)。

## 1. 现在为什么读得懂

仓库里只剩**两类「插件」**，各有明确的组合方式：

| 位置 | 是什么 | 怎么进装配 |
| --- | --- | --- |
| `packages/plugins/<name>` | NIDE 插件（manifest + 贡献点 + 可选后端） | 插件管理器扫描 `packages/plugins`（内置）与 `<userData>/plugins`（用户装） |
| 其余 `packages/*` | Cordis 插件（host 服务 / 客户端界面包） | 服务由 `packages/bundle/base` 的 patch 行提供；界面包在 package.json 声明 `nide.client` |

三个「装配点不在配置里」的信号都已消除：

1. profile 不再手写行：`profiles/desktop/cordis.yml` 只剩 profile 自己的行，宿主服务
   住在 `packages/bundle/base/cordis.patch.yml`，用户覆盖在 `cordis.patch.yml`；
2. 加一个 host 服务 = 在 bundle 里加一行，不改 `packages/host`；
3. 加一个窗口 = 新增 `client-ui-*` 包 + 声明 `nide.client.windowTypes` + 跑
   `pnpm gen:client-roster`，`client-runtime` 没有分支。

## 2. 目标分层

```
packages/
  contracts/             # 跨进程契约：类型 + 纯函数 + 词条基础表（无 Electron / DOM / IO）
  kernel/                # Cordis 树 + RPC 注册表 + transport + ctx.shell 反桥
  shell/                 # Electron 外壳：main（窗口/菜单/对话框/日志/协议）+ preload
  services/              # host 业务，一包一个（project content config plugins i18n appearance secrets ai）
  bundle/base/           # 组合包：宿主服务的 patch 行
  plugins/<name>/        # NIDE 插件（manifest + 贡献点；只能依赖 sdk）
  client-runtime/        # 客户端 Cordis 树 + slot + bundle loader + 生成的花名册
  client-kit/            # 客户端平台层：stores / ui 基础组件 / 窗口外壳 / logger / monaco
  sdk/                   # 插件开发者 API：视图渲染管线（PluginSlot / host-context）
  client-ui-*/           # 三个窗口的界面（各自声明 nide.client.windowTypes）
  boot/ hello/ host/     # host 运行时（host 只剩装配）
profiles/desktop/        # package.json（bundles）+ cordis.yml + cordis.patch.yml
apps/desktop/renderer/   # 渲染进程引导壳（main.tsx + assets）
```

四条规则，读懂全仓只需要这四条：

1. **装配点是分层的**：`nide.profile.bundles` → `cordis.yml` → `cordis.patch.yml`，
   后写的按 id 覆盖；关掉 / 替换任意能力只改最后一层；
2. **每个包导出 `apply(ctx)`**：host 侧用 `ctx.rpc.register(...)` 与 `ctx.provide(...)`，
   客户端用 `ctx.slots`，没有中央装配；
3. **客户端窗口种类来自包元数据**，由生成脚本变成静态 import，运行时不认识具体窗口；
4. **依赖方向单向**：`apps → kernel → shell/services/ui → sdk → contracts`，
   反向依赖一律视为设计错误（`contracts` 不得 import 任何包）。

## 3. 迁移顺序

每阶段结束都必须满足：`pnpm typecheck`、`pnpm typecheck:host`、`pnpm lint` 基线、
`pnpm test`、`pnpm dev` 可跑。阶段之间可独立提交、独立回退。

| 阶段 | 动作 | 风险 | 状态 |
| --- | --- | --- | --- |
| 0 | 写下这份约定 + 目标树，代码不动 | 极低 | 完成 |
| 1 | `src/shared` → `packages/contracts/src`（别名名暂留，见阶段 2） | 低（纯搬运） | 完成 |
| 2 | 别名 `@shared` → `@nide/contracts`，删掉旧名字 | 低（机械替换） | 完成 |
| 3 | `host/src/services/*` 各自成包，RPC 注册下沉到各自 `apply(ctx)`；`host/src/index.ts` 只剩装配 | 中 | 完成 |
| 4 | `src/main` → `packages/shell`：窗口 / 菜单 / 对话框 / 日志 / 协议收进一个包（尚未拆成 `ctx.shell.*` 服务） | 中 | 完成（包已搬） |
| 5 | `client-kit` 拆出 `sdk`（插件视图管线）；`client-runtime` 按声明装配窗口，引导壳去掉 `ROOTS` 兜底 | 中高 | 完成 |
| 6 | `src/renderer` → `apps/desktop/renderer`（`src/` 消失）；`cordis.yml` 列全所有包 | 低 | 完成 |

### 阶段 1 的实际改动（已提交）

- `src/shared` → `packages/contracts/src`，新增 `packages/contracts/package.json`
  （`name: @nide/contracts`、`type: module`，于是子目录里的 `{"type":"module"}`
  marker 只剩 `project/` 需要 —— 它带 `#project/*` 的 imports 映射）；
- 五处别名的目标路径（`tsconfig.{json,node,web,host}`、`electron.vite.config`、
  `vitest.config`、插件 bundle 构建脚本）从 `src/shared` 指向
  `packages/contracts/src`；别名名在阶段 2 一起改成 `@nide/contracts`。
- host 的运行时导入是**相对路径**（`../../../packages/contracts/src/...`），
  所以搬目录必须跟着改；`scripts/build-host.mts` 里复制 `imports` 映射的目标
  也跟着改成 `out/host/packages/contracts/src/...`。

## 3.1 阶段 3 的设计（内核 + 服务）

### 内核（`packages/kernel`）

只做三件事：RPC 注册表、父端口 / renderer 端口 transport、**上下文扩展**。

```ts
// packages/kernel/src/context.ts
interface NideContext extends Context {
  rpc:      { register(namespace, handlers): () => void }
  services: { provide(name, value), require<T>(name), has(name) }
  env:      HostEnvironment   // profileDir / profileName / home / userDataDir / appRoot
}
```

- `installNideContext(ctx, { rpc, env })` 把这三样挂上去（不可枚举、只读）；
- **服务名重复 provide 抛错**，`require` 找不到也抛 —— 装配错误在启动期暴露，
  而不是拖到第一次 RPC；
- 刻意不碰 Cordis 的 `provide` / `inject`：那套语义还在演进，先用一层 40 行、
  看得懂的注册表；等 loader 支持包标识符后可以平滑替换。

### 服务包

```ts
// packages/services/project/src/index.ts
export const projectService = {
  name: 'nide:service:project',
  apply(ctx: NideContext): void {
    const store = new HostProjectStore(ctx.env.userDataDir)
    ctx.services.provide('project', store)
    ctx.rpc.register('project', { list: () => store.list(), /* … */ })
  }
}
```

约定：

1. **服务只 import `@nide/contracts` 与 `@nide/kernel` 的类型**，不 import 宿主入口，
   也不互相 import —— 互相取用一律走 `ctx.services`；
2. **每个服务自己注册 RPC 命名空间**（namespace 与包名一一对应）；
3. `host/src/index.ts` 最后只剩：解析参数 → `boot(paths)` → `installNideContext` →
   `ctx.plugin(service)` 若干 → `attachHostIpc`。

### 阶段 3 完成后的样子

```
packages/kernel/src/{rpc,ipc,shell,context}.ts
packages/services/
  project/     project.*       projects.json 的唯一实现
  content/     files.* gallery.* overview.*（同一批读写实现）
  config/      config.*        + 作为「项目配置纯函数库」被 content 复用
  plugins/     plugins.*       清单 / 贡献点 / 内建视图表
  i18n/        i18n.*          I18nService：refresh() + HostI18n
  appearance/  appearance.*
  secrets/     （无 RPC）      基础设施：由 ai 服务 require
  ai/          ai.*            SSE sink 由入口注入，服务不碰 transport
packages/host/src/index.ts     363 行：参数 → profile → boot → kernel → services → transport
```

`test/host/services.test.ts` 把整条装配链跑一遍：真的构造实例、真的往
`RpcRegistry` 注册，断言命名空间集合、服务名唯一、`provide` 冲突会抛。

### 已经落地的部分（本阶段第一步）

- `packages/shell/src/{main,preload}`：Electron 外壳整体搬出 `src/`；
  `electron.vite.config.ts` 的 main / preload 入口与 `tsconfig.node.json` 的 include
  跟着改，`src/` 现在只剩 `apps/desktop/renderer`（引导壳，阶段 6 处理）；
- `packages/kernel/src/{rpc,ipc,context}.ts`：RPC 注册表与 transport 从
  `packages/host/src/` 搬进来；`installNideContext` 新增；
- `host/src/index.ts` 里 `host` 命名空间改走 `hostCtx.rpc.register(...)`，
  作为「服务怎么写」的样板；其余 namespace 仍是本地 `rpc.register`，逐批迁；
- `test/host/kernel-context.test.ts` 钉住：三样都在、注册真的落到同一张表、
  重复 provide / 缺失 require 抛错、扩展属性只读且不可枚举。

## 4. `cordis.yml` 现在就是装配点

```yaml
- id: hello                                   # 普通 Cordis 插件（kind 省略 = plugin）
  name: '{{NIDE_ROOT}}/packages/hello/src/index.ts'

- id: project                                 # 宿主服务（kind: service）
  name: '{{NIDE_ROOT}}/packages/services/project/src/index.ts'
  kind: service
- id: content
  name: '{{NIDE_ROOT}}/packages/services/content/src/index.ts'
  kind: service
# … config / plugins / i18n / appearance / secrets / ai
```

## 4. 与 DSH 对齐（阶段 A–D）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| A | 所有 profile 行都是 Cordis 插件：`ctx.provide` + `inject`，删除 `kind: service`、自建服务容器与宿主里的手工 apply | 完成 |
| B | 分层 patch：`packages/bundle/base` → profile `cordis.yml` → `cordis.patch.yml`，`config` 整体替换、按 id 覆盖 | 完成 |
| C | 客户端花名册由包元数据生成（`nide.client.windowTypes` → `roster.generated.ts`），运行时不认识窗口 | 完成 |
| D1 | 内置插件从 `plugins/builtin` 搬进 `packages/plugins`，成为普通包；装配不再需要单独的 `plugins/` 树 | 完成 |
| D2 | 安装 = npm 包 + 往 profile patch 写一行（替换现在的「目录 + manifest」安装协议） | 未做 |

D2 是**产品决策**而不是纯重构：现在的 manifest 插件（贡献点 / 权限 / 后端）不是
Cordis 插件，要让 loader 直接挂载它们，需要把插件协议改成「包 + 行」，并重写安装 /
卸载 / 权限元数据。`packages/plugins` 已经按这个方向摆好，但 D2 之前第三方的安装
路径仍然是目录扫描。

### 装配顺序备忘

`nide:host`（`rpc` + `hostEnv`）由宿主在挂载 profile 之前先挂上；服务通过
`inject: ['rpc', 'hostEnv', ...]` 取用。`env` 这个名字不能用：Cordis 自带 `ctx.env`
（EnvData），同名会被依赖守卫拦下。`loader.await()` 只等 import，激活要逐 fiber
等待（`packages/boot` 的 `awaitEntries`，带 15s 超时）。
