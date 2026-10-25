# 插件 UI 的运行时 bundle（方案 A）

状态：MVP 已接入，开发期可用；生产环境的协议分发仍是 TODO。
相关决策：`docs/architecture/cordis-migration.md` 的 D4 / D17。

## 为什么是 A

两条候选路线：

- **A. IIFE + 平台全局**（本文件）：插件 client 半打成 IIFE，React/ReactDOM 由宿主挂在
  `window` 上，bundle 加载时调用 `window.__NIDE_REGISTER__(viewId, Component)`。
- B. ESM + import map + `nide-plugin://`：更“原生”，但要处理 CSP、React 单例、
  相对 import 解析，开发和生产的路径差异更大。

先选 A：它最接近 DSH 的 lazy factory 思路，React 单例天然成立，而且不依赖浏览器的
import map 支持。B 以后可以作为内部实现替换，插件契约不用变。

## 契约

### 插件 manifest

`manifest.json` 增加：

```json
"client": {
  "platform": "web",
  "bundle": "dist/client.js"
}
```

- `bundle` 是**相对插件目录**的路径；
- 具体有哪些视图仍由 `contributes.views[]` 声明，`client` 只说明“有没有浏览器半、在哪儿”；
- 没有 `client` 的插件是纯后端 / 纯数据插件（语言包就是这种）。

### bundle 的要求

1. 必须是 **IIFE**（Vite `build.lib.formats = ['iife']`）；
2. 加载时调用：
   ```js
   window.__NIDE_REGISTER__('demo.hello', DemoView)
   ```
3. **不要打包 React / ReactDOM**：它们由宿主以全局变量提供（见下）；
4. 用 classic JSX（`React.createElement`），不要用 `react/jsx-runtime`——
   后者需要额外的全局，当前没有提供；
5. 视图组件的 props 与现有插件视图一致（目前是空 props，靠 `useViewChrome` 取外壳能力）。

参考实现：`plugins/builtin/demo/src/ui/client-entry.tsx`。

### 平台全局（宿主注入）

renderer 入口在加载任何 bundle 之前设置：

```ts
window.React = React
window.ReactDOM = ReactDOM
window.__NIDE_REGISTER__ = (id, component) => runtime.modules.register(id, component)
```

`__NIDE_REGISTER__` 由 `packages/client-runtime` 在创建客户端树时安装；
`PluginSlot` 只读 `ClientModuleRegistry`，不直接认识 bundle。

## 数据流

```
manifest.client
  -> pluginRegistry（主进程）
  -> host:get-client-bundles（纯数据：pluginId / platform / bundle 绝对路径）
  -> preload hostAPI.getClientBundles()
  -> client-runtime 的 loadClientBundles()
  -> <script src="/@fs/<abs path>">（开发期）
  -> bundle 调 __NIDE_REGISTER__
  -> ClientModuleRegistry
  -> PluginSlot 按 viewId 取组件
```

没有 bundle / 加载失败时，`PluginSlot` 继续走构建期 `import.meta.glob` 的兜底，
界面不会空白。

## 构建

```bash
pnpm build:plugin-demo
```

产物：`plugins/builtin/demo/dist/client.js`（已 gitignore）。

脚本：`scripts/build-plugin-client.mjs`。它用 Vite 的 JS API：

- `build.lib` + `formats: ['iife']`；
- `external: ['react', 'react-dom']` + `output.globals`；
- `esbuild.jsx = 'transform'`，强制 classic JSX；
- 别名与主工程一致（`@renderer` / `@shared`）。

当前只硬编码 demo。等 `nide.client` 的声明稳定后，改成遍历插件目录。

## 开发 vs 生产

| 环境 | bundle 来源 | 状态 |
| --- | --- | --- |
| dev | Vite `/@fs/<绝对路径>` | 可用 |
| 生产 | TODO：`nide-plugin://` 或 app 协议，从 `plugins/<id>/dist/` 读 | 未实现 |

`packages/client-runtime/src/loader.ts` 在非 DEV 下会直接跳过并告警，避免留下
“开发能跑、打包就坏”的隐形路径。

## 已知限制

- **只支持 classic JSX**：用自动 JSX 的插件需要宿主额外提供 `react/jsx-runtime` 全局。
- **CSS 还没处理**：bundle 里的样式不会自动注入。当前 demo 没有自己的 CSS；
  以后要么限制插件用宿主的设计 token，要么给 bundle 增加一个样式注入约定。
- **构建脚本硬编码 demo**：还没有“按插件目录批量构建”。
- **没有 HMR**：改插件 UI 需要重新 `build:plugin-demo` 并刷新页面。
- **没有版本/能力校验**：bundle 与宿主的 React 版本、API 版本目前靠约定。
- **信任模型**：bundle 在 renderer 里执行，拥有与宿主 UI 相同的 DOM/`hostAPI` 权限。
  没有沙箱；安装第三方插件时按“完全信任的代码”处理。

## 为什么不在 renderer 里直接 import 磁盘 TSX

- 生产环境没有 Vite dev server，`import()` 不认识 `.tsx`；
- 渲染进程在 Chromium 沙箱里没有 fs，不能读任意路径；
- 构建期 `import.meta.glob` 只能覆盖 `plugins/builtin/*`，第三方插件进不来。

所以必须先构建、再由宿主提供 URL。

## 测试步骤

```powershell
pnpm build:plugin-demo
$env:NIDE_HOST='1'
pnpm dev
```

启用 Demo Plugin，打开 `demo.hello`，期望：

```text
[nide] client bundle loaded {"pluginId":"builtin.demo",...}
[nide] client module registered by bundle {"id":"demo.hello"}
[plugin-slot] view served by client modules {"viewId":"demo.hello"}
```

如果只看到 `[nide] failed to load client bundles`，检查：

1. `plugins/builtin/demo/dist/client.js` 是否存在；
2. manifest 的 `client.bundle` 是否指向它；
3. DevTools Console 里是否有 `__NIDE_REGISTER__` 相关的报错。
