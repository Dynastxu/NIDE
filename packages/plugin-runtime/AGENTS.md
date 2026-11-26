# AGENTS.md — 插件子系统

插件子系统由**五个包**组成，一包一个 `ctx` 键。改这里之前先读
[docs/architecture/plugin-permissions.md](../../docs/architecture/plugin-permissions.md)、
[plugin-backend.md](../../docs/architecture/plugin-backend.md)、
[plugin-lifecycle.md](../../docs/architecture/plugin-lifecycle.md)。

| 包                    | `ctx` 键              | 职责                                                                                       |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| `plugin-runtime`      | `plugins`             | 清单解析（`toEntry`）、扫描 / 注册、启停偏好、贡献点、安装事务、内建视图注册表、profile 行 |
| `plugin-permissions`  | `plugin-permissions`  | 声明展开 + RPC 准入（`RpcAuthorizer` 实现）、作用域变量                                    |
| `plugin-storage`      | `plugin-storage`      | 每插件 JSON 存储（`<userData>/plugin-storage/<id>.json`），100ms 合并写盘                  |
| `plugin-capabilities` | `plugin-capabilities` | `ctx.host` 桌面能力的权限检查（`os.*`）→ kernel 反向桥                                     |
| `plugin-backend`      | `plugin-backend`      | fork worker、沙箱 flags、起停 / 重扫、`dispatchHostCall`、卸载脚本                         |

**装配**：五个包各是普通 Cordis 服务，由 `packages/bundle/base/cordis.patch.yml`
各挂一行。它们之间**不互相 import 实现**，也**不互相注入**：
`plugin-backend` → 注入 `plugins` / `plugin-permissions` / `plugin-storage` /
`plugin-capabilities`；`plugin-runtime` 反向只按需 `ctx.get()`（注入成环会互相
PENDING，与 i18n 同一套处理）。类型用 `import type` 跨包引用，`pnpm lint:imports` 管着。

## 文件职责

### plugin-runtime（清单与生命周期）

| 文件                      | 职责                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `plugins.ts`              | `PluginManager`：清单解析、扫描 / 注册、启停偏好、贡献点、安装事务、卸载                |
| `plugin-contributions.ts` | manifest 贡献点收敛（视图 / 设置页 / 语言包 / chrome）                                  |
| `builtin-views.ts`        | 内建视图注册表（`ctx.builtinViews`）+ 文件树登记；版本控制 / 提交由 `packages/git` 注册 |
| `profile-rows.ts`         | 安装行：往 profile 的 `cordis.patch.yml` upsert / remove `plugin:<id>`                  |
| `index.ts`                | 服务装配 + `plugins.*` / `plugin.call` RPC                                              |

### plugin-backend（子进程）

| 文件               | 职责                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `runtime.ts`       | fork worker、起停 / 重扫、`dispatchHostCall`、`uninstall()`                               |
| `paths.ts`         | `buildBackendFlags` / `ensureWriteRoots` / `resolveWorkerEntry`（runtime 与卸载脚本共用） |
| `worker.ts`        | 子进程入口：动态 import `main`、`activate(host)`、storage 视图、host-call                 |
| `protocol.ts`      | 宿主 ⇄ worker 消息契约与 `STORAGE_FLUSH_MS`                                               |
| `storage-value.ts` | 存储值必须可 JSON 序列化（写之前校验）                                                    |
| `uninstall.ts`     | 卸载脚本（worker 内跑，失败不删目录；存储路径由调用方传入）                               |

### 其余三包

| 包                    | 文件              | 职责                                |
| --------------------- | ----------------- | ----------------------------------- |
| `plugin-permissions`  | `permissions.ts`  | 准入判定、能力映射与路径提取        |
| `plugin-storage`      | `storage.ts`      | 存储实现；`filePath()` 给卸载脚本用 |
| `plugin-capabilities` | `capabilities.ts` | `os.*` 声明检查 + 转 shell 执行     |

## 不可破坏的不变量

1. **清单解析只有一个入口**：`toEntry()`。安装、扫描、`registerPackage()` 都走它；
   解析失败 = 整份拒绝该插件（不降级成 full）。
2. **权限语义**（`contracts/plugin-api/permissions.ts`）：
   - 缺省 `permissions` = `trust: "full"`；**空数组 = 零能力 sandboxed**；
   - 非空 v1 数组 = `full`；v2 对象缺 `trust` = `sandboxed`；
   - 写错的声明让插件被忽略，不要「尽力解析」。
3. **准入在 RpcRegistry 分发之前**，依据 `RpcRequest.caller.pluginId`：
   - 没有 caller（核心 UI / shell）= 放行；
   - `full` = 放行；
   - `sandboxed`：`fs.read/write` 按展开作用域、`net` 约束 `ai.*`、插件管理只对 full；
     取不到路径**拒绝**，不要猜。
4. **后端沙箱只在 `sandboxed` 时存在**：`--permission` + `--allow-fs-read|write`；
   可读集合必须包含 **worker 所在目录**（它 import 同目录的 `protocol.js` /
   `storage-value.js`）、worker 入口、插件目录与声明作用域；写作用域要**预建目录**。
   `exec` 是全有全无（`--allow-child-process`）；**网络不在 Node 权限模型里**。
5. **桌面能力独立于 trust**：`os.*` 没声明就拒绝，`trust: "full"` 也不放行；
   参数在 runtime 与 shell 两侧都要校验。
6. **存储值必须可 JSON 序列化**：`Map` / `Set` / 函数 / `BigInt` / 循环引用在 `set`
   时抛错，不能等落盘时静默丢。
7. **安装 = 目录 + profile 里的一行**：行是装配真相，由 `plugin-shim` 按
   `config.dir` 注册；安装失败要回滚行、目录、注册三样；卸载顺序是
   停后端 → flush → 卸载脚本 → 卸行 → 删目录 → 撤销注册。内置插件不可卸载。
8. **注册表与扫描**：`registerPackage` 的条目存在独立的 registered 集合里，
   `scan()` 必须保留它们；`remove()` 要同时清 registered，否则删掉的插件会复活。
9. **worker 的宿主调用**：只转发白名单方法；`hostCall` 有 30s 超时；参数先校验类型，
   不要 `String(args)` 兜底。

## 测试

- `test/host/plugin-permissions.test.ts`：准入判定；
- `test/host/plugin-backend.test.ts`：flags / 写目录 / 激活；
- `test/host/plugin-install-rows.test.ts`：安装行 + loader 挂载 + 卸载；
- `test/host/profile-rows.test.ts`：patch 行的 upsert / remove / 保留用户行；
- `test/host/plugin-storage.test.ts` / `plugin-storage-value.test.ts`：存储与值校验；
- 改协议 / 权限后跑 `pnpm typecheck:host`、`pnpm lint:imports`、`pnpm test`，并同步
  上面三份文档。

## 边界（别过度承诺）

- 渲染进程插件是**声明式**边界：直接摸 `window.hostAPI` 或 `setCaller` 可绕过；
- `net.hosts` / `ports` 没有逐调用比对；`exec` 没有逐程序白名单；
- UI 沙箱（iframe / 独立进程）尚未实现，见 issue #6；不要在本子系统声称「已隔离 UI」。
