# 插件生命周期

> 对齐 mics 的 `plugin.json` 生命周期字段：默认启用策略、激活事件、依赖、安装 /
> 升级事务与卸载脚本。后端进程本身见 [plugin-backend.md](plugin-backend.md)。

## 1. 清单字段

```json
{
  "id": "acme.notes",
  "name": "Notes",
  "version": "0.1.0",
  "main": "dist/main.js",
  "uninstall": "dist/uninstall.js",
  "activation": ["onStartup", "onView:acme.notes.panel"],
  "dependencies": ["acme.storage"],
  "core": false,
  "essential": false,
  "experimental": true,
  "defaultDisabled": true,
  "permissions": { "trust": "sandboxed" }
}
```

| 字段               | 语义                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `activation`       | `*` / `onStartup` / `onView:<viewId>` / `onCommand:<commandId>`；省略 = 按需（第一次 `plugin.call` 才拉起后端） |
| `dependencies`     | 依赖的插件 id；激活后端前先激活依赖                                                                             |
| `core`             | 内核级插件：界面不可禁用（`setEnabled` 直接忽略）                                                               |
| `essential`        | 必需插件：同上；语义是「缺了它就无法从界面恢复自身」                                                            |
| `experimental`     | 实验性标记，只影响展示                                                                                          |
| `defaultDisabled`  | 首次出现时默认关闭；用户显式启用后写进偏好                                                                      |
| `uninstall`        | 卸载脚本（只有声明了 `main` 的插件才能用）                                                                      |
| `activationEvents` | 旧字段，仍作为 `activation` 的别名                                                                              |

## 2. 启用状态

偏好文件是 `<userData>/plugin-preferences.json`：

```json
{ "version": 1, "disabled": ["acme.broken"], "enabled": ["acme.notes"] }
```

判定顺序（`isPluginEnabled`）：

1. `core` / `essential` → 永远启用；
2. 在 `enabled` 里 → 启用（默认禁用插件被用户打开过）；
3. 在 `disabled` 里 → 禁用；
4. 清单 `defaultDisabled: true` → 禁用；
5. 其余 → 启用。

`plugins.disabled` 下发的是**实际**禁用集合（含默认禁用且没被显式启用的），
所以渲染进程过滤视图时不需要再懂默认值。`setPluginEnabled` 对 `core` /
`essential` 是空操作，界面上的复选框直接置灰。

## 3. 激活

| 声明              | 行为                                                                 |
| ----------------- | -------------------------------------------------------------------- |
| `*` / `onStartup` | 宿主 ready 之后启动后端                                              |
| `onView:<id>`     | 该视图第一次被打开时启动（`PluginSlot` 会调 `plugins.activateView`） |
| `onCommand:<id>`  | 命令系统尚未实现，目前不会触发                                       |
| 省略              | 按需：第一次 `plugin.call` 时启动                                    |

依赖在激活前递归启动（同一轮用 `visited` 斩断循环）；依赖没装 / 被禁用时这次
启动失败，状态记为 `failed`，错误信息在 `plugins.backends` 里。

## 4. 安装与升级

`plugins.install(sourceDir)` 的事务顺序：

1. 校验源目录的 manifest；
2. 复制到 `<userData>/plugins/.staging/<目录>.<时间戳>`；
3. 在暂存目录里**再校验一次**（复制过程中坏掉 / 换 id 都挡在这里）；
4. 旧版本 rename 成备份 → 暂存目录 rename 成正式目录 → 删备份；
5. 重新扫描；新装默认禁用，升级保留原来的启用状态。

任何一步失败都会清掉暂存目录，并在目标已被替换时回滚旧版本。`.staging` 是
隐藏目录，扫描时直接跳过。

## 5. 卸载

`plugins.remove(id)`：

1. 停掉后端进程；
2. 如果声明了 `uninstall`，在**子进程**里跑脚本（与后端同一套权限参数，见
   [plugin-backend.md](plugin-backend.md)），超时 10s；
3. 脚本失败 → 返回 `{ ok: false, reason: 'uninstall-failed' }`，**目录不删**；
4. 成功 → 删除插件目录 → 重新扫描 → 对齐后端。

卸载脚本的上下文：

```js
export default async ({ id, dir, storageFile, storage, log }) => {
  log(`cleaning ${id}`)
  // storage 是 <userData>/plugin-storage/<id>.json 的只读快照
}
```

内置插件不能卸载；第三方插件只在目录确实位于 `<userData>/plugins` 内时才删除。

## 6. 目前没有的

- 命令系统（`onCommand` 只是解析通过，没有触发源）；
- 插件之间的版本约束（只有 id 依赖，不校验版本）；
- 安装来源只有本地文件夹（npm 来源按 D6 明确跳过）。
