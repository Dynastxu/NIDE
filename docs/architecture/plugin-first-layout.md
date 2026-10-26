# 走向「一切皆插件」的目录结构

> 这份文档只讲**结构**：现在的目录为什么难读、目标长什么样、按什么顺序改。
> 功能细节看 [HANDOFF.md](HANDOFF.md)，渲染侧 bundle 看
> [plugin-ui-bundles.md](plugin-ui-bundles.md)。

## 1. 现在为什么难读

仓库里同时存在**三种「插件」**，但只有第三种是真的：

| 位置 | 是插件吗 | 实际形态 |
| --- | --- | --- |
| `plugins/builtin/*` | **是** | manifest + 贡献点（视图 / 设置页 / 语言包）+ 可选 `dist/client.js` |
| `packages/client-ui-{main,welcome,settings}` | 不是 | 普通 React 包，`client-runtime` 用 `switch (windowType)` **硬编码**加载 |
| `packages/host/src/services/*` | 不是 | 普通函数模块，由 `host/src/index.ts` 里约 800 行 `rpc.register(...)` 装配 |

三个信号说明「装配点不在配置里」：

1. `profiles/desktop/cordis.yml` 里只有 `hello` 一行 —— 真正的装配写在 TypeScript 里；
2. 新增一个 host 能力要改 `packages/host/src/index.ts`；
3. 新增一个窗口/功能区要改 `src/renderer/src/main.tsx` 的 `ROOTS` 与 `client-runtime` 的分支。

## 2. 目标分层

```
apps/desktop/            # 可执行物：main.ts（app.whenReady -> boot(profile)）+ preload + index.html
packages/
  contracts/             # 跨进程契约：类型 + 纯函数 + 词条基础表（无 Electron / DOM / IO）
  kernel/                # Cordis 树 + RPC 注册表 + profile 解析 + 生命周期（@nide/kernel）
  shell/                 # Electron 能力做成插件：window / menu / dialog / log / protocol
  services/              # host 业务，一包一个：project files config plugins i18n appearance ai secrets
  sdk/                   # 插件开发者 API：plugin-api 的 token/类型 + client-kit 的 slot/组件/store
  ui/                    # 客户端功能区，一包一个：explorer editor settings welcome git …
plugins/builtin/<name>/   # 第三方扩展，只能依赖 sdk
profiles/desktop/cordis.yml  # 唯一的装配点
```

三条规则，读懂全仓只需要这三条：

1. **`cordis.yml` 是唯一装配点** —— 关掉 / 替换任意能力或界面，只改这份文件；
2. **每个包导出 `apply(ctx)`** —— host 侧用 `ctx.rpc.register(...)`，客户端用
   `ctx.slots` / `ctx.commands`，不再有中央装配；
3. **依赖方向单向**：`apps → kernel → shell/services/ui → sdk → contracts`，
   反向依赖一律视为设计错误（`contracts` 不得 import 任何包）。

窗口种类也不再是 `switch`：`client-runtime` 按「谁对 `windowTypes` 声明了自己」装配。

## 3. 迁移顺序

每阶段结束都必须满足：`pnpm typecheck`、`pnpm typecheck:host`、`pnpm lint` 基线、
`pnpm test`、`pnpm dev` 可跑。阶段之间可独立提交、独立回退。

| 阶段 | 动作 | 风险 | 状态 |
| --- | --- | --- | --- |
| 0 | 写下这份约定 + 目标树，代码不动 | 极低 | 完成 |
| 1 | `src/shared` → `packages/contracts/src`（别名名暂留，见阶段 2） | 低（纯搬运） | 完成 |
| 2 | 别名 `@shared` → `@nide/contracts`，删掉旧名字 | 低（机械替换） | 完成 |
| 3 | `host/src/services/*` 各自成包，RPC 注册下沉到各自 `apply(ctx)`；`host/src/index.ts` 只剩装配 | 中 | 完成 |
| 4 | `src/main` → `packages/shell`：窗口 / 菜单 / 对话框 / 日志 / 协议变成 `ctx.shell.*` 服务 | 中 | 待做 |
| 5 | `client-kit` 拆成 `sdk` + `ui/*`；`client-runtime` 按声明装配窗口 | 中高 | 待做 |
| 6 | `apps/desktop` 只剩 bootstrap；`cordis.yml` 列全所有包 | 低 | 待做 |

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

- `packages/kernel/src/{rpc,ipc,context}.ts`：RPC 注册表与 transport 从
  `packages/host/src/` 搬进来；`installNideContext` 新增；
- `host/src/index.ts` 里 `host` 命名空间改走 `hostCtx.rpc.register(...)`，
  作为「服务怎么写」的样板；其余 namespace 仍是本地 `rpc.register`，逐批迁；
- `test/host/kernel-context.test.ts` 钉住：三样都在、注册真的落到同一张表、
  重复 provide / 缺失 require 抛错、扩展属性只读且不可枚举。

## 4. 阶段 3 之后 `cordis.yml` 的样子（示意）

```yaml
- id: kernel
  name: '@nide/kernel'
- id: shell
  name: '@nide/shell'
- id: project
  name: '@nide/service-project'
  inject: [kernel, shell]
- id: files
  name: '@nide/service-files'
  inject: [project]
- id: ui-main
  name: '@nide/ui-main'
  inject: [sdk]
```

到那时「这个功能在哪」的答案是：**一个包 + `cordis.yml` 的一行**，而不是三处代码。
