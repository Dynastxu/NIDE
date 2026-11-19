# 插件权限（对齐 mics）

> 形状照 mics：`manifest.json` 的 `permissions` 既接受老的单层字符串数组，也接受
> v2 的结构化对象；宿主解析时统一归一化，运行时只有一种形状。

## 1. 声明

```json
{
  "id": "acme.notes",
  "name": "Notes",
  "version": "0.1.0",
  "permissions": {
    "trust": "sandboxed",
    "fs": {
      "read": ["${project}", "${pluginDir}/data"],
      "write": ["${project}/notes"]
    }
  }
}
```

| 字段                               | 取值                                                       | 说明                                                                         |
| ---------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `trust`                            | `full` / `sandboxed`                                       | 省略时 **v2 对象默认 `sandboxed`**；整个字段省略 = `full`；`[]` = 零能力沙箱 |
| `fs.read` / `fs.write` / `fs.meta` | 目录数组                                                   | 绝对路径或以 `${变量}` 开头；不允许 `..`；末尾 `/**` 允许，段内通配不允许    |
| `exec`                             | `[{ bin, args? }]`                                         | `args` 是正则白名单；没有对应宿主能力，目前只校验与展示                      |
| `net`                              | `{ mode, hosts?, ports?, allowPlainHttp?, allowPrivate? }` | `mode: all` 只能配 `trust: full`；`allowlist` 必须给 `hosts`                 |
| `os`                               | `{ openExternal?, notifications?, clipboard?, dialogs? }`  | 桌面能力，目前只校验与展示                                                   |
| `secrets`                          | `none` / `own` / `all`                                     | 密钥仓范围；目前只校验与展示                                                 |

路径变量：`${project}`（当前项目根）、`${userData}`、`${pluginDir}`、`${temp}`、
`${home}`。未知变量只警告，运行时该条作用域不会展开 —— **展开不出来就不放行**。

**非空**老数组继续有效，并统一归一化成 `trust: 'full'`：

```json
{ "permissions": ["network", "secrets:own"] }
```

支持的老字符串：`network`、`secrets:own`、`shell:openExternal`、`dialog:open`、
`dialog:save`、`clipboard:write`、`notifications:show`。未知字符串只警告，不阻断加载。

老写法没有区分「打开」与「保存」对话框，所以 `dialog:open` 归一化成
`os.dialogs: "save"`（两者都允许），升级后不会突然弹不出保存框；v2 的 `"open"`
则只给打开，与界面文案一致。

`"permissions": []` 是例外：它是「一个能力都不要」的显式声明，归一化成
`{ trust: 'sandboxed' }`（零能力），而不是完全信任。老数组会拿到 `full` 是因为
v1 插件跑在主进程、权限表只是额外能力的白名单；空数组没有这层历史包袱，
给它 `full` 等于凭空多给能力。

**声明写错会让整个插件被忽略**（启动日志里有错误明细）：把 `{ trust: 'sandboxed' }`
的拼写错误静默降级成完全信任，等于悄悄放开它没声明的能力。

## 2. 两种信任级别

| 级别                            | 行为                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `full`（缺省、全部老 manifest） | 与迁移前一致：宿主不限制文件 / 网络 / 子进程；`net` 只用于展示；**`os` 仍要逐项声明**（见 `plugin-capabilities.md`） |
| `sandboxed`                     | 宿主按声明检查：`fs` 作用域之外的读写被拒绝；没声明 `net` 时 `ai.*` 被拒绝；插件管理（安装 / 卸载 / 启停）一律拒绝   |

## 3. 执行点

准入检查在 **RpcRegistry**（`packages/kernel/src/rpc.ts`）分发之前：
`RpcAuthorizer` 拿到完整的 `RpcRequest`，宿主入口在服务装配完成后把它接到
`PluginPermissionGuard`（`packages/plugin-permissions/src/permissions.ts`）。

调用方身份来自 `RpcRequest.caller.pluginId`：

- 插件 UI 通过 SDK 的 **`useHost().api`** 调用宿主时，preload 会把插件 id 带进请求；
- 核心 UI（宿主自己的窗口）不设置 caller，因此不受插件权限约束；
- 没有 caller 的调用一律放行。

`fs` 检查按**方法形状**取路径（`files.writeFile` 取 `filePath`、
`files.createEntry` 取 `targetPath`、`gallery.updateRegistry` 这类只收名字的
方法回落到当前项目根）。取不到路径时**拒绝**，不猜：传相对路径的调用等于没有
可判定的路径，同样会被拒绝。

桌面能力（`ctx.host` 的 openExternal / 对话框 / 剪贴板 / 通知）**不走这里**：
它们由 `PluginCapabilities` 检查，所以 `trust: "full"` 也不会自动放行。
两层检查各自独立，新增能力时别只改一边（见 `plugin-capabilities.md`）。

## 4. 边界（重要）

这是**声明式**的权限边界，不是 JS 沙箱：

- 插件 bundle 与宿主 UI 跑在同一个渲染进程里，直接摸 `window.hostAPI` 或
  `window.nideHost` 仍然能绕过；
- `useHost().api` 只是把 `setCaller` 包进 `try/finally`，而 `setCaller` 本身仍在
  `window.hostAPI` 上：插件可以自己调用它冒充别的 id。这一层防的是「不知不觉
  越权」，不是「恶意插件」；把 `setCaller` 变成私有通道是后续工作；
- 只有走 `useHost().api` 的调用会被检查；事件 / 定时器回调里发起的调用不带
  caller，等于没有身份；
- `net` 的 `hosts` / `ports` 还没有在调用时逐条比对（AI 的 URL 由宿主按供应商
  配置决定）。

真正的强制隔离在插件后端：`manifest.main` 跑在独立子进程里，`sandboxed` 时由
Node 的 `--permission` / `--allow-fs-*` / `--allow-child-process` 强制文件与子进程
边界（见 [plugin-backend.md](plugin-backend.md)）。`exec` 的声明目前只用于生成
`--allow-child-process`（子进程权限是全有全无，具体程序由插件自己判断）。

## 5. 界面

- 「设置 -> 插件」详情页按声明显示信任级别、文件作用域、网络、程序、系统能力与密钥范围；
- 启用第三方插件前的确认框按 `trust` 二选一措辞：`full` 说明「可以读写任意文件、
  访问网络」，`sandboxed` 说明「只能使用清单里声明的能力」。

## 6. 加一个受管能力

1. 在 `capabilityOf()` 里把 `namespace.method` 映射到已有的能力
   （`fs.read` / `fs.write` / `net` / `manage`），或在
   `pathsOf()` 里补上路径提取；
2. 新能力如果是独立类别，先在 `packages/contracts/src/plugin-api/permissions.ts`
   的 `PluginPermissions` 里加字段与校验；
3. 详情页（`PluginsBrowser`）加一行展示；
4. `test/host/plugin-permissions.test.ts` 与 `test/shared/plugin-api/permissions.test.ts`
   各补一条。

## 7. 相关文件

| 文件                                               | 职责                                                      |
| -------------------------------------------------- | --------------------------------------------------------- |
| `packages/contracts/src/plugin-api/permissions.ts` | 声明类型、校验 / 归一化、变量展开、路径判断（浏览器安全） |
| `packages/plugin-permissions/src/permissions.ts`   | 声明 -> 能力检查；`RpcAuthorizer` 的实现                  |
| `packages/plugin-runtime/src/plugins.ts`           | 扫描时解析 `permissions`；写错的 manifest 整份忽略        |
| `packages/kernel/src/rpc.ts`                       | `RpcAuthorizer` 挂载点（分发前）                          |
| `packages/shell/src/preload/index.ts`              | `setCaller` + 把 `caller.pluginId` 带进 RPC 请求          |
| `packages/sdk/src/plugin-views/plugin-api.ts`      | 插件侧受限 API（`useHost().api`）                         |
