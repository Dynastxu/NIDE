# 插件后端与工作进程

> 对应 mics 的 `pluginWorkerHost` + `plugin-host/worker`：插件清单里的 `main` 在
> 独立子进程里跑，文件 / 子进程权限由 Node 的 `--permission` 强制。

## 1. 声明

```json
{
  "id": "acme.notes",
  "name": "Notes",
  "version": "0.1.0",
  "main": "dist/main.js",
  "permissions": {
    "trust": "sandboxed",
    "fs": { "read": ["${project}"], "write": ["${userData}/notes"] }
  }
}
```

- `main` 必须是**插件目录内**、真实存在的 ESM 文件；跑出目录或文件不存在时只忽略
  后端（视图 / 设置页照常加载），启动日志里有原因。
- 插件后端可选。纯 UI 插件不写 `main`。

## 2. 插件侧 API

默认导出 `{ activate, deactivate }`，也可以直接导出一个函数（等价于 `activate`）：

```js
export default {
  activate(host) {
    host.log.info('notes backend ready')

    // 注册给渲染进程调用的方法（宿主 RPC `plugin.call`）
    const off = host.handle('notes.list', async (params) => {
      return await notes.list(params?.project)
    })

    // 返回清理函数，或者改用 deactivate()
    return () => off()
  }
}
```

`host` 的形状（类型见 `packages/contracts/src/plugin-api/backend.ts`）：

| 字段                                                               | 说明                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| `id`                                                               | 清单里的插件 id                                       |
| `paths.userData` / `paths.pluginDir` / `paths.temp` / `paths.home` | 绝对路径；插件不能假设 Electron API                   |
| `log.info/warn/error`                                              | 走宿主日志（带插件 id）                               |
| `handle(method, handler)`                                          | 注册方法，返回注销函数；插件停用时自动清空            |
| `storage`（后续）                                                  | 每插件命名空间的键值存储                              |
| `host`（后续）                                                     | 受权限检查的桌面能力（外链 / 对话框 / 剪贴板 / 通知） |

## 3. 调用

渲染进程 / 核心 UI 统一走宿主的 `plugin` 命名空间：

```ts
window.nideHost.invoke('plugin', 'call', pluginId, method, params)
// 或任意 host RPC 入口
```

后端没启动时这一调用会先拉起（懒启动），失败把错误回给调用方。

## 4. 进程与权限

- 后端跑在 `child_process.fork` 出来的子进程里；`--permission` 只在
  `trust: 'sandboxed'` 时加，`full` 与迁移前一样不受限；
- 参数由 [runtime.ts](../../packages/services/plugins/src/backend/runtime.ts) 的
  `buildBackendFlags()` 生成：
  - worker 自身与插件目录**始终可读**（否则 `import` 第一步就失败）；
  - 声明的 `fs.read/meta/write` 作用域 → `--allow-fs-read`，写作用域再加
    `--allow-fs-write`；
  - 声明了 `exec` 才加 `--allow-child-process`（Node 的子进程权限是全有全无，
    具体允许哪个程序由插件自己判断）；
  - 写作用域会由宿主**预建目录**（Node 的 `--allow-fs-write` 不允许创建目录本身）。
- 子进程崩溃只影响这个插件：状态转 `failed`，下一次 `plugin.call` 会重新拉起。
- 宿主退出时 `stopAll()` 先停后端再卸载 Cordis 树，不会留孤儿进程。

## 5. 目前不支持的

- 后端插件不能声明定时器 / 事件总线 / capability provider（mics 有 `ctx.timer` /
  `ctx.on` / `capabilities`）；
- 只支持 ESM；CJS 后端入口会 `import` 失败；
- 第三方插件的依赖必须随插件一起放在插件目录里（`node_modules` 在目录内即可），
  目录外的模块在 `sandboxed` 下读不到 —— 这是有意的边界。
