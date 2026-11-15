# 插件存储与桌面能力

> 对应 mics 的 `ctx.storage` 与 `ctx.host`（`openExternal` / 对话框 / 剪贴板 /
> 通知）。两者都只给**后端**（`manifest.main`）用；渲染进程侧仍是既有 UI API。

## 1. 存储

```js
export default {
  activate(host) {
    const count = host.storage.get('launches', 0)
    host.storage.set('launches', count + 1)
    host.storage.delete('scratch')
  }
}
```

- 一个插件一个命名空间：`<userData>/plugin-storage/<encodeURIComponent(id)>.json`；
- 插件侧是**同步**视图：`get` / `set` / `delete` / `keys`，`set` 立刻可见；
- 落盘有 100ms 合并窗口；插件停用、卸载、宿主退出前会 flush；
- 启动时整份快照经 bootstrap 交给子进程，插件不需要自己读文件；
- 文件坏掉按空存储处理（只告警，不影响启动）；
- **值必须是 JSON 能原样表达的**（`null` / 字符串 / 布尔 / 有限数字 / 数组 / 纯对象）。
  `Map`、`Set`、`Date`、函数、`BigInt`、`undefined`、类实例、循环引用都会在 `set`
  时直接抛错 —— 它们能过进程边界（结构化克隆），却会在落盘时被悄悄改写，插件要
  等到下次启动才会发现数据没了。

## 2. 桌面能力

| `ctx.host` 方法            | 需要的声明                    | 宿主执行                                  |
| -------------------------- | ----------------------------- | ----------------------------------------- |
| `openExternal(url)`        | `os.openExternal`             | `shell.openExternal`（只接受 http/https） |
| `openPath(target)`         | `os.openExternal`             | `shell.openPath`（只接受绝对路径）        |
| `showOpenDialog(options?)` | `os.dialogs: open` 或 `save`  | `dialog.open`                             |
| `showSaveDialog(options?)` | `os.dialogs: save`            | `dialog.save`                             |
| `readClipboard()`          | `os.clipboard: read`          | `clipboard.readText`                      |
| `writeClipboard(text)`     | `os.clipboard: write \| read` | `clipboard.writeText`                     |
| `notify({ title, body? })` | `os.notifications`            | `notification.show`                       |

规则：

- **`trust: 'full'` 不会自动放行**这些能力 —— 「完全信任」约束的是文件与子进程，
  不是替用户点外链 / 弹对话框 / 读剪贴板。没声明就抛错，不会「先做了再说」；
- 检查在宿主侧（`PluginCapabilities`），子进程只能请求白名单里的方法；这条路径
  **不经过** RPC authorizer（`plugin-permissions.md` §3）—— 文件 / 网络 / 插件管理
  由 authorizer 管，桌面能力由这里管，两层各自独立，加新能力时别只改一边；
- `os.dialogs: "save"` 同时允许打开与保存；`"open"` **只**允许打开（界面文案与之一致）；
- shell 侧还有第二层校验（参数形状、URL scheme、绝对路径），见
  `packages/shell/src/main/host/capabilities.ts`；
- 错误以 reject 回到插件：`插件 <id> 没有声明权限 os.openExternal`。

## 3. 卸载脚本里的存储

卸载脚本拿到的是**只读快照**：

```js
export default ({ storageFile, storage }) => {
  // storage 是卸载开始前 flush 过的内容
}
```

宿主在跑脚本前会 flush 一次存储；脚本结束后目录与存储文件一起删除。脚本失败时
两者都保留（见 [plugin-lifecycle.md](plugin-lifecycle.md)）。

脚本与后端共用一套 Node 权限参数：`sandboxed` 插件只能读写 `fs.read` / `fs.write`
声明的目录（`--allow-fs-*` 由 worker 目录、插件目录与声明的目录拼出来），
`trust: "full"` 不受限。所以「卸载时清理插件在目录外留下的东西」这件事，必须
在 `fs.write` 里声明对应路径，否则脚本自己会 EACCES。

## 4. 还没做的

- 渲染进程插件没有对应的 `ctx.host` / `ctx.storage`（UI 插件目前直接用
  `window.hostAPI`；要接的话需要先给 SDK 增加带权限检查的 RPC 面）；
- 能力范围只有上面七项：没有 shell 执行、没有自定义协议、没有系统托盘。
