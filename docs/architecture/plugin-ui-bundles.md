# 插件 UI 的运行时 bundle（方案 A）

状态：开发期与打包后都能加载（生产走 `nide-plugin://` 自定义协议）。
相关决策：`docs/architecture/cordis-migration.md` 的 D4 / D17。

**已知限制**：打包后**只有** `plugins/**`（内置）与 `<userData>/plugins` 里的
`dist/client.js` 会被加载；第三方插件必须自带构建产物（安装时不构建，见下）。

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
  -> PluginManager（host）
  -> plugins.clientBundles（纯数据：pluginId / platform / bundle 绝对路径）
  -> plugins.contributions（视图 / 设置页 / 语言包，另一条）
  -> preload hostAPI.getClientBundles()
  -> client-runtime 的 loadClientBundles()
  -> <script src="/@fs/<abs path>">      （开发期）
     或 <script src="nide-plugin://…">   （打包后）
  -> bundle 调 __NIDE_REGISTER__
  -> ClientModuleRegistry
  -> PluginSlot 按 viewId 取组件
```

没有 bundle / 加载失败时，`PluginSlot` 继续走构建期 `import.meta.glob` 的兜底，
界面不会空白。`clientBundles` 也**不会返回**指向不存在文件的条目（manifest 声明了
`client` 但作者没构建 / 打包漏了 `dist/` 时，直接回退 glob，而不是让渲染进程去请求
一个必然 404 的 URL）。

## 构建

```bash
pnpm build:plugin-clients          # 所有声明了 client 的内置插件
pnpm build:plugin-demo             # 只构建 demo（--only demo，迭代时用）
```

产物：`<插件目录>/<manifest.client.bundle>`，demo 是
`plugins/builtin/demo/dist/client.js`（已 gitignore）。

脚本 `scripts/build-plugin-client.mjs` 遍历 `plugins/builtin/*/manifest.json`，
**只挑 `client: { platform:'web', bundle }` 的插件**，入口固定为插件目录下的
`src/ui/client-entry.tsx`。它用 Vite 的 JS API：

- `build.lib` + `formats: ['iife']`；
- `external: ['react', 'react-dom']` + `output.globals`；
- `esbuild.jsx = 'transform'`，强制 classic JSX；
- 别名与主工程一致（`@renderer` / `@shared`）；
- `emptyOutDir: false` —— bundle 有可能声明在插件根上，清目录会删掉源码。

打包前必须先跑它：`dist/` 是 gitignore 的，electron-builder 只带磁盘上已有的文件。

## 开发 vs 生产

| 环境 | bundle 来源 | 状态 |
| --- | --- | --- |
| dev | Vite `/@fs/<绝对路径>` | 可用 |
| 生产 | `nide-plugin://plugin/<pluginId>/client.js`（shell 注册的自定义协议） | 可用 |

生产这条路是 [src/main/protocol/plugin-bundles.ts](../../src/main/protocol/plugin-bundles.ts)：

- `app.whenReady()` **之前** `protocol.registerSchemesAsPrivileged` 登记
  `nide-plugin`（standard + secure + fetch）；
- ready 之后 `protocol.handle` 收请求：URL 里**只有 pluginId**（path 里，
  `encodeURIComponent` 过 —— 不能放 host，URL 解析会把 host 小写化），处理器拿这个
  id 去 host 的 `plugins.clientBundles` 里查绝对路径，读到文件后以
  `text/javascript` 返回；
- 所以「允许清单」就是 host 那份清单，渲染进程拼不出一个能读到别处的 URL；
- CSP（`src/renderer/index.html`）里 `script-src` 加了 `nide-plugin:`，否则
  Chromium 会拦掉这个来源的脚本。

`loaded` 集合按 URL 去重：dev 是绝对路径、打包后是 pluginId，两种形态都成立。
单个 bundle 失败只告警、不影响其它插件（`loadClientBundles` 逐个 try/catch）。

## 已知限制

- **只支持 classic JSX**：用自动 JSX 的插件需要宿主额外提供 `react/jsx-runtime` 全局。
- **CSS 还没处理**：bundle 里的样式不会自动注入。当前 demo 没有自己的 CSS；
  以后要么限制插件用宿主的设计 token，要么给 bundle 增加一个样式注入约定。
- **每个插件只有一个入口文件**：协议只认 `/client.js`，bundle 里不能 `import()`
  兄弟文件 —— 需要拆分的插件自己打成一个文件。
- **构建脚本硬编码 demo**：还没有“按插件目录批量构建”。
- **第三方插件不代构建**：装进来的是作者构建好的 `dist/`；缺了就回退到 glob（第三方
  没有 glob，等于这个视图加载失败）。
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
pnpm dev
```

启用 Demo Plugin，打开 `demo.hello`，期望：

```text
[nide] client bundle loaded {"pluginId":"builtin.demo",...}
[nide] client module registered by bundle {"id":"demo.hello"}
[plugin-slot] view served by client modules {"viewId":"demo.hello"}
```

打包后（`pnpm build:unpack`，用 `electron.exe dist\win-unpacked\resources\app` 起）
同一个视图的日志里 `url` 应变成 `nide-plugin://plugin/builtin.demo/client.js`；
如果它回退到 glob（看不到 `client bundle loaded`），检查：

1. `plugins/builtin/demo/dist/client.js` 是否真的进了 `resources/app`（`pnpm
   build:plugin-demo` 要在 `build:unpack` 之前跑，`dist/` 是 gitignore 的）；
2. 主进程日志里有没有 `Plugin bundle requested but not in the host catalog`（说明
   host 的清单里没有它：插件被禁用，或文件不存在）；
3. DevTools Console 里是否有 CSP 报错（`nide-plugin:` 没加进 `script-src`）。

如果只看到 `[nide] client bundle failed to load`，检查：

1. `plugins/builtin/demo/dist/client.js` 是否存在；
2. manifest 的 `client.bundle` 是否指向它；
3. DevTools Console 里是否有 `__NIDE_REGISTER__` 相关的报错。
