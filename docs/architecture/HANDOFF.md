# NIDE 迁移交接（2026-10-26）

> 新会话先读这份，再读 [cordis-migration.md](cordis-migration.md) 与
> [plugin-ui-bundles.md](plugin-ui-bundles.md)。三份都是当前有效的约定，不是历史记录。

## 0. 一句话状态

Cordis/DSH 架构的**核心竖切已经跑通**：Electron shell → 独立 host 进程 → 通用 RPC →
客户端 Cordis 树 → slot → 运行时插件 UI bundle。项目文件 / 章节 / 图鉴 / 概述 /
项目配置 / **项目生命周期（列表 / 打开 / 移除 / 关闭）** / **插件的视图 / 设置页 /
语言包 / manifest 词条** / **本地化（语言包瀑布、语言偏好、标题解析）** 的实现只有
一份，在 host；插件清单 / 启停 / 本地安装 / 卸载 / 信任确认也在 host。现有界面外观未改。

**但旧实现没有全部迁完**：核心 UI 组件仍在 shell（D1），theme/AI/secrets 已迁完
（逐项见 §4.1）。下一步不是继续加新功能，而是在 §4 里挑一条搬完。

## 1. 目标与已锁定决策

目标：NIDE 的架构对齐 DSH，插件不做沙箱隔离；**UI 长相不变**（位置、颜色、字号、
间距、窗口 chrome 都不变）。

| 编号 | 结论 |
| --- | --- |
| D1 | A：全量 dogfood，核心 UI 也是 client 插件 |
| D2 | A：host 跑独立 Node 进程，Electron main 只做 shell |
| D3 | A：Cordis 4.x + ESM |
| D4 | A：DSH 式 client modules；当前实现为「IIFE + 平台全局」，见 plugin-ui-bundles.md |
| D6 | 第三方插件只从 npm 装；默认禁用；启用要确认 |
| D7 | 插件不 import electron；桌面能力由 shell 通过 `ctx.shell` 暴露（尚未实现） |
| D8 | A：DSH 式命名 slot |
| D9 | Monaco 进平台模块表，但只暴露 `@nide/editor-api` |
| D10 | B：i18n 改为每包 `locale/*.json`（尚未开始） |
| D17 | 框架层直接依赖；引擎层 vendor；UI 层不引入 DSH 包 |

## 2. 目标进程与代码结构

```
Electron shell（src/main）
├─ 窗口 / 菜单 / dialog / tray / update / preload
├─ utilityProcess.fork(packages/host/src/index.ts)   ← 必需（启动时无条件拉起）
└─ 建窗时 MessageChannelMain：一个 port 给 host，一个给 renderer

Host（packages/host，纯 Node ESM）
├─ Cordis root + loader + profile（packages/boot）
├─ RpcRegistry（host/src/rpc.ts）
├─ HostProjectStore（services/project-store.ts）：`projects.json` 的唯一实现
│  （list / current / startup / setCurrent / open / forget / close）
├─ 文件读写（services/project-files.ts）：readDir / readFile / readChapters /
│  readForeshadowing / writeFile / createEntry / renameEntry / deleteEntry /
│  gallery / overview 的读与新建
├─ 项目配置（services/project-config.ts）：load / update / initialize / registry /
│  resolve / remapOverviewRole
├─ 插件清单（services/plugins.ts）：list / disabled / setEnabled / clientBundles /
│  contributions / install / remove / rescan / views / settings
├─ 插件贡献点（services/plugin-contributions.ts）：唯一的插件目录读取方
│  （视图 / 设置页 / 语言包 / manifest 词条）
├─ 本地化（services/i18n.ts）：语言包注册表 + 逐 key 瀑布 + 语言偏好
│  （`<userData>/locale.json`）+ manifest 标题解析
├─ 主题 / 外观（services/appearance.ts）：偏好（`<userData>/appearance.json`）+ 主题解析
└─ `shell` 反向桥（shell.ts）：host 需要 Electron 能力时反向调 shell
   （`nativeTheme` / `safeStorage`，见 §3「ctx.shell」）

Client（renderer，HTTP 页面里的第二棵 Cordis 树）
├─ src/renderer/src/main.tsx：引导壳（按窗口种类 import 三个包、挂 slot）
├─ packages/client-runtime：Context + slots + modules + bundle loader
├─ packages/client-kit：共享层（stores / ui / 窗口外壳 / 插件视图管线）
├─ packages/client-ui-main / client-ui-welcome / client-ui-settings：窗口 UI 本体
├─ packages/client-ui-layout：六个工具区的 slot 插件
├─ packages/client-ui-slots / client-ui-renderer
└─ packages/client-modules：viewId -> Component
```

目录：

```
apps/            # 计划中，尚未创建
packages/
  boot/ host/ hello/
  client-runtime/ client-modules/
  client-kit/                  # 客户端共享层：stores / ui / window 外壳 / logger
  client-ui-slots/ client-ui-renderer/
  client-ui-main/ client-ui-layout/ client-ui-welcome/ client-ui-settings/
profiles/desktop/   # package.json + cordis.yml + cordis.patch.yml
vendor/            # 已删除（改用 pnpm 依赖）
docs/architecture/ # 本文件 + 迁移方案 + bundle 说明
```

## 3. 已完成（可运行、已验证）

### 宿主进程
- 启动时 `src/main/host/process.ts` 用 `utilityProcess.fork` 拉起 host（不再是开关）；
- 等 `{type:'ready'}`，支持 ping/pong、shutdown、超时 kill；host 退出后下一次调用会重新拉起；
- host 入口 `packages/host/src/index.ts`：Cordis `Context` + loader + 插件；
- 生命周期日志：`host process is ready`、`host ready ... ipc=true`。

### RPC 与宿主业务
- 协议：`src/shared/host-rpc/index.ts`；host 分发：`packages/host/src/rpc.ts`；
- namespace：`host.info`、`project.list/current/startup/setCurrent/open/forget/close`、
  `files.readDir/readFile/readChapters/readForeshadowing/writeFile/createEntry/renameEntry/deleteEntry`、
  `gallery.read/create/updateRegistry`、`overview.read/setRole`、
  `config.read/update/initialize`；
- preload 暴露 `window.nideHost.invoke(ns, method, ...args)`；
- preload 的上面这些 `projects.*` 方法全部 host 优先；旧 IPC 通道保留为回退，但
  **只是转发**——主进程里不再有第二份实现（`src/main/services/project-*.service.ts` 已删）；
- shell → host 也有一条父端口 RPC（`invokeHost`）：新建项目时的
  `config.initialize` 由主进程直接发起，那时窗口可能还没建出来；旧 IPC 的转发器也走它；
- 图鉴 / 概述的「报上来的路径必须正是配置里那个目录」在 host 判：配置服务已经搬过去；
- 删除的二次确认留在 shell（host 没有窗口）：preload 先走
  `host:project-confirm-delete` 问一句，用户同意后再调 host；
- 改名之后的概述映射在 host 内部补（`remapOverviewRole`）；
- `project.setCurrent` 在每个窗口 port 建立后按 `--nide-project=` 同步，换项目时 host 跟着切。

### 项目生命周期（host）
- `src/main/services/project-store.ts` 已删除；`projects.json` 只剩下
  [packages/host/src/services/project-store.ts](packages/host/src/services/project-store.ts)
  这一份实现，shell 通过新增的 [src/main/host/project.ts](src/main/host/project.ts)
  （`listProjects` / `startupProject` / `openProject` / `forgetProject` / `closeProject`）
  经父端口调用它；
- `project.open/forget/close` 是这一次新接的写路径：打开 = 记进列表 + 落盘 + 记为当前，
  forget 只删记录（磁盘目录不动），close 只清「当前项目」（列表与 `lastOpened` 都不动）；
- **建窗要等 host**：`openStartupWindow()` 已经变成 async —— 开主窗口还是欢迎窗口取决于
  host 读出来的 `projects.json`。代价是首窗要等 host ready（约 0.4s），
  host 起不来则回落成欢迎窗口；
- shell 只保留一个 `boundProjectPath`（[src/main/window.ts](src/main/window.ts)）：这是
  **主窗口绑定的项目**，不是第二份 store —— 项目路径经 `additionalArguments` 在建窗时
  固定，重建窗口（切语言 / 重启）时只能原样再用一次。写入点是
  `createMainWindow()` / `activateMainWindow()`，两个都吃 host 给的记录；
  主窗口被关掉或回到欢迎窗口时清空；
- 换项目的判据（要不要问「切换会丢失未保存内容」）用 `getBoundProjectPath()`：即将被
  重建的就是这个窗口，它绑着谁才是答案；
- host 不可达时开项目返回 `{ ok: false, reason: 'unreadable' }`（不再谎称「目录不存在」）；

### 插件（host 是唯一读目录的一方）
- [packages/host/src/services/plugins.ts](packages/host/src/services/plugins.ts) 扫描
  `<appRoot>/plugins/builtin` 与 `<userData>/plugins`，维护 manifest 清单、禁用集合、
  client bundle 绝对路径，以及每个插件的**贡献点**；
- 贡献点的读取（读 manifest、路径守卫、chrome / location 收敛、语言包与
  `package.nls*.json`）在
  [plugin-contributions.ts](packages/host/src/services/plugin-contributions.ts)；
  搬迁期间的 `src/main/plugin-host/*`（loader / registry / permission / sandbox /
  errors / host-views / preference）已全部删除；
- RPC：`plugins.list` / `disabled` / `setEnabled` / `clientBundles` / `views` / `settings` /
  `install` / `remove` / `rescan`；`contributions` 不再是 RPC（shell 不需要了），
  只作为 host 内部聚合点与语言包来源；
- shell 侧**没有任何缓存表 / 镜像了**：`src/main/plugin-host/` 已整个删除。
  三条内建视图（文件树 / 版本控制 / 提交）也搬进 host
  （[packages/host/src/services/builtin-views.ts](packages/host/src/services/builtin-views.ts)）——
  它们的标题是宿主词条，词条表与当前语言都在 host，放在 shell 拼会让一次查询跨两份翻译；
- `getPluginViews` / `getPluginSettings` / `getDisabledPlugins` / `setPluginEnabled`
  都是**直通**：host 是唯一写方与唯一读源，壳不再保留副本；
- `getPlugins` / `getClientBundles` 读 host，失败时给空列表；
  判断「是不是第三方」也问 host 的清单（`findPlugin`）；
- **安装 / 卸载**：`plugins.install(sourceDir)` 复制到 `<userData>/plugins`、默认禁用；
  `plugins.remove(id)` 只删第三方。shell 负责选目录（`host:install-plugin`）与卸载
  确认（`host:remove-plugin`），成功后只刷新禁用镜像并用 `plugin:enabled-changed`
  广播 —— host 自己已经重扫过，视图 / 设置页下次查询就是新的；
- **信任确认**：启用第三方插件时走 `CONFIRM_SPECS.enableThirdPartyPlugin`（内置插件
  不问），用户取消则 `setPluginEnabled` 返回 false，界面回滚到宿主的真实禁用集合；
- **浏览器半补加载**：`plugin:enabled-changed` 到达主窗口时先
  `reloadClientBundles()` 再重拉视图列表，所以新装 / 启用的 UI 插件**不用重启**
  就会出现；dev 下 Vite 的 `server.fs.strict` 已关掉，`/@fs/` 也能读 userData 里的
  第三方 bundle；打包后走 `nide-plugin://`（见下一节）。

### 本地化（host）
- [packages/host/src/services/i18n.ts](packages/host/src/services/i18n.ts)：
  `LanguagePackRegistry`（逐 key 瀑布：第三方 -> 内置 -> 中文基础表）、语言偏好
  （`<userData>/locale.json`）、`HostI18n`（`init` / `setLocale` / `payload`）、
  `resolvePluginTitle`（manifest 的 `%key%` 解析）；
- RPC：`i18n.init({ system })` / `i18n.setLocale(locale)` / `i18n.payload()`。
  **系统语言候选由 shell 传**（`app.getPreferredSystemLanguages()` 只有 Electron 知道）；
- 中文基础表直接用 `src/shared/i18n/locales/zh-CN.ts`（那个文件没有任何 import，
  host 能当纯 ESM 加载）；
- shell 侧 [src/main/i18n/index.ts](src/main/i18n/index.ts) 只缓存一份 `I18nPayload`：
  窗口标题 / 原生菜单 / 对话框 / `--nide-locale=` 启动参数都要**同步**取文案，
  那一步跑不了 IPC。切语言 = 问 host 要新载荷 + 重建窗口（重建仍在 shell）；
- shell 的 `language-packs.ts` / `preference.ts` / `manifest-nls.ts` 全部删除；
  语言偏好文件从 shell 挪到 host 后**路径不变**（同一个 userData），老用户的偏好照常生效。

### 主题 / 外观（host）
- [packages/host/src/services/appearance.ts](packages/host/src/services/appearance.ts)：
  `appearance.json` 偏好、`findBuiltinTheme` 校验、`fallbackFrom` 语义、原生明暗
  （`shell.call('nativeTheme.setSource')`）；
- RPC：`appearance.init` / `appearance.payload` / `appearance.setTheme`
  （返回 `{ payload, preference }`，主题不存在时回 `null`）；
- shell 侧 [src/main/appearance/index.ts](src/main/appearance/index.ts) 只缓存 `AppearanceState`：
  窗口底色（`backgroundColor`）与 `--nide-appearance=` / `--nide-theme-palette=`
  启动参数都在建窗那一刻定死，跑不了 IPC；`nativeTheme.on('updated')` 仍挂在 shell
  （Electron 事件），只用来让 host 重算一次、变了再广播；
- 共享层为了能被 host 加载做了两处调整：`theme/builtin.ts` 改成**纯数据**（三个 id
  常量搬进去、类型用 `./types.js` 纯类型导入），`appearance/preference.ts` 独立出来
  （`DEFAULT_APPEARANCE.theme` 写成字面量，由 `test/shared/theme/theme-data.test.ts`
  钉住与 `DEFAULT_THEME` 一致）。

### ctx.shell（host → shell 的反向能力桥）
- 协议在 [src/shared/host-rpc/index.ts](src/shared/host-rpc/index.ts)：
  `shell-call` / `shell-result`，方法名是白名单 `ShellMethod`
  （`nativeTheme.setSource` / `nativeTheme.shouldUseDarkColors` /
  `safeStorage.status|encrypt|decrypt`；密文走 base64，解密结果带 `shouldReEncrypt`）；
- host 侧 [packages/host/src/shell.ts](packages/host/src/shell.ts) 的 `ShellBridge`：
  `call(method, args, timeoutMs)`，没挂在 shell 下时直接 reject（独立运行不假装成功），
  shell 退出时 `detach()` 把挂着的调用全部拒掉；
- shell 侧 [src/main/host/capabilities.ts](src/main/host/capabilities.ts)：
  `handleShellCall` 按白名单执行并回包，参数逐个校验；`attachShellCapabilities(proc)`
  在 `process.ts` 启 host 时挂上；
- 使用者：`services/appearance.ts`（主题）与 `services/secrets.ts`（密钥仓）。

### AI 供应商 / 密钥（host）
- [packages/host/src/services/ai-provider.ts](packages/host/src/services/ai-provider.ts)：
  配置读写、测试连接、`open` 的 SSE 转发（逻辑与搬迁前逐条一致，含「改 Base URL
  必须重输 key」这条防转发规则）；
- 配置在 `<userData>/ai-provider/providers.json`（[ai-provider-config.ts](packages/host/src/services/ai-provider-config.ts)），
  密钥在 `<userData>/secrets/<owner>/<id>.bin`（[secrets.ts](packages/host/src/services/secrets.ts)，
  加解密走 `safeStorage` 反向桥，测试注入假后端）；
- HTTP 在 [ai-provider-http.ts](packages/host/src/services/ai-provider-http.ts)（从 shell 原样搬来）；
- **流式事件**：`ai.open` 返回 `requestId`，之后的分片走 host → shell 的
  `stream-event`（[host-rpc](../../src/shared/host-rpc/index.ts) 的 `HostStreamEvent`），
  shell 的 `subscribeHostStream` 按 requestId 找到发起窗口再转给渲染进程；
- shell 的 [ai-provider.ipc.ts](src/main/ipc/ai-provider.ipc.ts) 只剩三件事：
  插件启用检查、窗口归属（分片只回发起者、窗口销毁即取消）、载荷形状校验。
  领域错误码以 `{ ok:false, error }` 的形式跨进程（RPC 的错误包装只剩 message）。

### 客户端共享层（@nide/client-kit）
- [packages/client-kit/src](packages/client-kit/src)：`stores/`（zustand 的十张表）、
  `ui/`（基础组件）、`window/`（窗口外壳：`WindowFrame` / `WindowControls` /
  `useWindowTitle`）、`logger`、`icons.tsx`、`appearance/palette.ts`、
  `plugin-views/`（`PluginSlot` / `PluginHostProvider` / `host-context`：插件视图的渲染管线）；
- 别名 `@nide/client-kit/*` → `packages/client-kit/src/*`
  （tsconfig.web / electron.vite.config / vitest.config 三处一致）；Vite 的 alias
  按前缀匹配，所以子路径直接可用；
- **依赖方向**：kit 不许 import `@renderer/*`。`entry-action.store` 与
  `window/MainMenu` 因为依赖 explorer / editor 的功能代码，留在 `src/renderer/src`
  等主窗口整体搬走；
- Tailwind 的 `@source` 加了 `packages`（类名在包里的文件也要被扫到，否则样式会丢）。

### 窗口包（D1 完成）
- **welcome**：`packages/client-ui-welcome/src` 里是 `WelcomeApp` / `ProjectsPanel` /
  `SettingsButton` 本体；插件入口 `index.ts` 注册 `welcome.root`，同时导出
  `WelcomeApp` 给渲染进程的引导壳用；
- **settings**：`packages/client-ui-settings/src` 里是 `SettingsApp` / 设置树 /
  各设置页 / `RestartDialog` / `PluginsBrowser` / `PluginSettingsSlot`；
  表单入口注册 `settings.root`，并导出 `PluginsBrowser`（欢迎窗口的「插件」页复用它）
  与 `RestartDialog`（欢迎窗口也会用）；
- **main**：`packages/client-ui-main/src` 里是 `App`（启动编排）/ `MainApp`（窗口外观）
  / `layout` / `editor` / `explorer` / `entry` / `git` / `host-view` / `view` /
  `plugins/HostSlot` / `window/MainMenu` / `stores/entry-action.store`；
- **`src/renderer/src` 只剩引导壳**：`main.tsx` + `assets/`（Tailwind 入口与浅色表）
  + `env.d.ts`。引导壳按 `windowType` 动态 import 三个包里的窗口组件，然后挂
  client-runtime 的 slot；
- 别名：`@nide/client-ui-*` / `@nide/client-kit` 的子路径是**正则**别名，必须排在
  精确别名前面 —— 字符串别名会把 `pkg/sub` 拼成 `index.ts/sub`；
- 旧的 `@renderer` 别名（tsconfig.node / tsconfig.web / vite / vitest / bundle 脚本）
  已全部删除：仓库里不再有这个路径映射。

### 客户端 Cordis / slots
- `packages/client-runtime`：按 `windowType` 加载 main/welcome/settings 插件；
- `main.root` / `welcome.root` / `settings.root` 都已接入；
- `zone.leftTop` … `zone.bottomRight` 六个工具区已接入；
- `WorkbenchLayout` 用 `<Slot name="zone.*" fallback={<ToolZone .../>}>`，没有注册者时旧路径照常；
- `Slot` 不产生包装 DOM（`createElement`）。

### 插件 UI 运行时 bundle（dev + 打包后）
- manifest `client: { platform:'web', bundle:'dist/client.js' }`；
- host `plugins.clientBundles` → preload → `client-runtime` 注入 IIFE；
- bundle 调 `window.__NIDE_REGISTER__(viewId, Component)` 注册；
- demo 的 bundle 已构建：`plugins/builtin/demo/dist/client.js`（71 KB）；
- **打包后走 `nide-plugin://plugin/<pluginId>/client.js`**：shell 注册的自定义协议
  （[src/main/protocol/plugin-bundles.ts](src/main/protocol/plugin-bundles.ts)），
  处理器只用 URL 里的 pluginId 去 host 的清单里查绝对路径，读出来以
  `text/javascript` 返回；CSP 的 `script-src` 里加了 `nide-plugin:`；
- `clientBundles` 不返回指向不存在文件的条目（声明了 `client` 但没构建 / 打包漏了
  `dist/` 时直接回退 glob）；
- 日志已验证（dev）：
  ```
  [nide] client bundle loaded
  [nide] client module registered by bundle {"id":"demo.hello"}
  [plugin-view] view served by client modules
  ```
- 没有 bundle / 加载失败时 `PluginSlot` 回退构建期 `import.meta.glob`。

### 编译 host 与打包
- `pnpm build:host`（[scripts/build-host.mts](scripts/build-host.mts)）用 TypeScript 的
  **Node API** 直接把源码编到 `out/host`（不 spawn，受限环境也能跑）；
- 产物与源码同构：`out/host/packages/host/src/index.js` 是可执行入口，
  `out/host/packages/hello/src/index.js` 是 profile 引用的插件，
  `out/host/src/shared/...` 是共享层，`out/host/profiles/...` 是**改写过的** profile
  模板（`.ts` → `.js`）；
- 三处细节，缺一个都跑不起来：
  1. 统一发射 **ESM**（`module: ESNext` + `moduleResolution: Bundler`）。用 NodeNext
     的话，没有 `type: module` marker 的共享目录会被编成 CJS，和产物根对不上；
  2. `out/host/package.json` 写 `{"type":"module"}`（它是打包后的「仓库根」）；
  3. `src/shared/project/package.json` 的 `#project/*` 映射要复制进产物并把 `.ts`
     改成 `.js`（否则 bare specifier 解析不了）；
- 打包版的入口与 profile：shell 在 `app.isPackaged` 时跑
  `<appRoot>/out/host/packages/host/src/index.js` 并传 `--dist-root <appRoot>/out/host`；
  host 用它当 profile 模板目录与 `{{NIDE_ROOT}}`。开发时仍跑源码
  `packages/host/src/index.ts`，行为不变；
- `electron-builder.yml` 的 `files` 因此只留 `out/**` + `profiles/**` + `plugins/**`
  + `package.json` —— 源码形式的 `packages/*` 与 `src/shared` 不再进包；
- **asar 已恢复**：主进程 / 预加载 / 渲染进程都在 asar 里；host 是
  `utilityProcess.fork()` 出来的独立进程，它的入口、profile、要动态 import 的插件
  必须是真实文件，所以 `out/host/**` 与 `plugins/**` 走 `asarUnpack` 放到
  `resources/app.asar.unpacked/`，shell 侧按 `app.asar` → `app.asar.unpacked` 换根
  （`packagedRoot()`），`--app-root` 与子进程 cwd 也用它；
- **签名**：证书不进仓库，走 electron-builder 的标准环境变量
  `CSC_LINK` / `CSC_KEY_PASSWORD`；没配时产物未签名（Windows 会拦 `nide.exe`）。

### 工程
- npm registry 已切 `https://registry.npmmirror.com/`（`.npmrc`）；
- `tsconfig.host.json`；`pnpm typecheck:host`；
- `pnpm host:dump` / `host:smoke`；
- 第一批 `e270b5f`：写路径（新建 / 改名 / 删除）搬完。
- 第二批 `b753126`：章节 / 伏笔 / 图鉴 / 概述 / 配置搬到 host；`src/shared/project`
  改成 `#project/*` 子路径导入（原 `@shared/yaml` 与免扩展名相对导入 Node 解析不了）。
  `pnpm test` 35 files / 583 tests 全绿（Vitest 能解析 `#project/*`）。
- 第三批 `f1cd701`：删掉主进程两份服务实现，旧 IPC handler 改成**转发**到 host；
  `config.initialize` 由 shell 经父端口 RPC（`invokeHost`）调用；host 变成启动必需；
  8 份服务测试从 `test/main/services` 搬到 [test/host](../../test/host)。
- 第四批 `8dbb073`：打包（`asar: false` + host 跑源码），`build:unpack` 产物已验证。
- 第五批 `59ed8af`：插件清单 / 禁用集合 / client bundle 收到 host；新增本地文件夹
  安装、第三方卸载、启用前的信任确认与插件页入口；`test/host/plugins.test.ts`。
- 第六批 `8ceb257`：项目生命周期统一到 host；`test/host/project-store.test.ts`。
- 第七批 `874940e`：插件 loader / 视图 / 设置页 / 语言包迁 host；
  `test/host/plugin-contributions.test.ts`。
- 第八批 `3334478`：生产 bundle 协议 —— `nide-plugin://` 自定义协议 + CSP +
  `clientBundles` 过滤缺文件的条目；`test/shared/plugin-api/plugin-bundle-url.test.ts`。
- 第九批 `1517f9b`：i18n 服务化 —— 语言包注册表 / 逐 key 瀑布 / 语言偏好 /
  manifest 标题解析全部进 host（`services/i18n.ts` + `i18n.*` RPC），
  `plugins.views` / `plugins.settings` 直接下发已解析标题的描述符；
  shell 删掉 `language-packs` / `preference` / `manifest-nls` 与四张缓存表，
  `src/main/i18n` 只留一份载荷缓存。`test/host/i18n.test.ts` 新增。
- 第十批 `68fac0e`：`ctx.shell` 反向能力桥 —— `shell-call` / `shell-result` 协议、
  host 的 `ShellBridge`、shell 的 `capabilities.ts`（`nativeTheme` / `safeStorage`
  白名单）；`test/host/shell-bridge.test.ts`。
- 第十一批 `e60325e`：theme / appearance 搬进 host —— `services/appearance.ts`
  持有偏好与解析，`nativeTheme` 走反向桥；shell 只缓存 `AppearanceState`（窗口底色 /
  启动参数要同步）。共享层 `theme/builtin.ts` 改成纯数据、`appearance/preference.ts`
  独立，host 才能加载。`test/host/appearance.test.ts`、`test/shared/theme/theme-data.test.ts`。
- 第十二批 `1408324`：AI 供应商 + 密钥仓搬进 host —— `services/ai-provider*.ts`、
  `services/secrets.ts`（`safeStorage` 反向桥，测试注入假后端）；RPC 增加
  `stream-event` 流式通道与 `subscribeHostStream`；shell 的 `ai-provider.ipc.ts`
  只剩启用检查 / 窗口归属 / 形状校验。`test/host/ai-provider.test.ts`、
  `test/host/secrets.test.ts`。
- 第十三批 `bbaa09f`：D1 第一步 —— 抽出 `packages/client-kit`（stores / ui /
  window 外壳 / logger / icons / palette），别名 `@nide/client-kit/*`，Tailwind
  `@source` 覆盖 packages；渲染进程的窗口级代码改 import kit，kit 不反向依赖渲染进程。
- 第十四批 `8280b8b`：D1 第二步 —— welcome / settings 两个窗口的组件搬进各自的包
  （`client-ui-welcome` 三个文件、`client-ui-settings` 十个文件 + `PluginsBrowser` /
  `PluginSettingsSlot` / `RestartDialog`）；插件视图渲染管线（`PluginSlot` /
  `PluginHostProvider` / `host-context`）进 kit 的 `plugin-views/`；引导壳按包名
  动态 import 窗口组件。窗口包别名是**正则子路径**，必须排在精确别名之前。
- 第十五批 `7f877d9`：D1 收尾 —— 主窗口的 `App` / `MainApp` / editor / explorer /
  entry / git / host-view / layout / view / `HostSlot` / `MainMenu` /
  `entry-action.store` 全部进 `client-ui-main`，`monaco-env` 进 kit；
  `src/renderer/src` 只剩 `main.tsx` + `assets` + `env.d.ts`；
  **`@renderer` 别名已从 tsconfig.node / tsconfig.web / vite / vitest / bundle 脚本里全部删除**。
- 第十六批 `1c34ec3` + `582ceab`：发布化 —— `pnpm build:host` 把 host 编到 `out/host`
  （ESM 统一发射 + 产物根 `{"type":"module"}` + `#project/*` 映射改写 + profile 模板
  改写）；shell 在打包版跑编译产物并传 `--dist-root`；`boot` 的 profile 模板目录与
  `{{NIDE_ROOT}}` 改成显式参数；asar 恢复，host 需要的真实文件走 `asarUnpack`；
  `electron-builder.yml` 只打 `out/**` + `plugins/**` + `package.json`；
  签名走 `CSC_LINK` / `CSC_KEY_PASSWORD`。**编译产物实跑验证过**，`build:unpack`
  仍需在用户终端跑。
- 第十七批（未提交）：删掉 shell 的最后两块旧实现 —— `src/main/plugin-host/`
  （`preference.ts` 禁用集合镜像、`host-views.ts` 内建视图表）与
  `src/main/services/file.service.ts` 整个删除；内建视图搬进 host
  （`services/builtin-views.ts`，标题与插件视图同一个解析器）；
  shell 的视图 / 设置 / 禁用集合 / 启停全部改成直通 host（启停失败不再假装成功）；
  `reloadPlugin` 占位链路（channel / handler / preload / d.ts）一并删掉；
  `ai-provider.ipc.ts` 的启用检查改成问 host。`test/host/builtin-views.test.ts` 新增。
- `pnpm test` 会跑 `test/host/**`，`pnpm typecheck:host` 同时检查 host 与这些用例。

## 4. 下一步优先级

按「先搬完旧实现，再加功能」排序：

1. ~~**项目生命周期统一到 host**~~ —— 已完成（第六批）。
2. ~~**插件 loader / 视图 / 设置页 / 语言包迁 host**~~ —— 已完成（第七批）。
3. **npm 安装来源**（D6）—— 用户当前明确**跳过**
   - 先定 pnpm 运行时；推荐自带 registry tarball 安装（需加 `tar` 依赖，v1 不做
     传递依赖），替换 `plugins.install` 的 sourceDir 输入，UI 加包名输入；
   - 插件市场标签页暂不做。
4. ~~**生产 bundle 协议**~~ —— 已完成（第八批，`nide-plugin://` + 批量构建）。
   仍剩：CSS 约定、HMR。
5. ~~**i18n 服务化**~~ —— 已完成（第九批）。语言包瀑布 / 偏好 / 标题解析都在 host，
   shell 只缓存一份载荷；`src/main/plugin-host` 的四张表随之删除。
   仍剩 D10（每包 `locale/*.json`，让插件自带 locale 目录而不是 manifest 里声明文件）。
6. ~~**发布化**~~ —— 编译 host（第十六批）、asar + `asarUnpack`（第十六批后半）。
   剩下：`build:win` 实跑验收、签名证书（`CSC_LINK` / `CSC_KEY_PASSWORD`）。
7. ~~**theme / appearance 服务化**~~ —— 已完成（第十一批）。
8. ~~**AI / secrets 服务化**~~ —— 已完成（第十二批，含 `stream-event` 流式通道）。
9. ~~**核心 UI 插件化（D1）**~~ —— 已完成（第十三 / 十四 / 十五批）：共享层
   `@nide/client-kit`、三个窗口的组件都在各自包里，`src/renderer/src` 只剩引导壳。
   仍剩的可选优化：把主窗口内部拆成 `zone.*` / `editor.*` 子 slot（现在是一个根组件）。
10. ~~**删掉 shell 的回退路径**~~ —— 已完成（第十七批）：禁用集合镜像、
    `host-views` 表、`reloadPlugin` 占位都删了，内建视图搬进 host。
    剩下**D10**（每包 `locale/*.json`）、视觉回归、`build:win` 实跑与签名。

### 4.1 迁移完成度（哪些还在旧实现）

**已迁到 host**：项目文件 / 章节 / 伏笔 / 图鉴 / 概述 / 配置；新建项目初始化；
项目生命周期（列表 / 打开 / 移除 / 关闭 / 启动恢复）；插件清单 / 启停 / 本地安装 /
卸载 / 信任确认 / **视图 / 设置页 / 语言包 / manifest 词条的读取**；
**本地化（语言包瀑布 / 语言偏好 / 标题解析）**；**主题 / 外观（偏好 + 解析，
nativeTheme 走反向桥）**；**AI 供应商 / 密钥仓**；通用 RPC；host 启动必需。

**仍在 shell**（按 D7 本来就该在 shell 的那部分）：
- logger（日志文件归 shell，host 的 stdout 由它接管，不打算搬）；
- window / menu / tray / update / dialog / confirm（按 D7 属于 shell）；
- 核心 UI 组件：**已全部进包**（`client-kit` + 三个窗口包），`src/renderer/src`
  只剩 `main.tsx` / `assets` / `env.d.ts`；
- asar（要解决 `utilityProcess.fork` 的 asar 入口与 profile 包标识符）、
  `build:win` 实跑、签名证书、视觉回归、D10。

**旧实现里也没有的**：插件后端（`manifest.main`）、依赖解析、profile bundle /
`cordis.patch.yml` / `!!js` / required 审计 / runtime resolution。

## 5. 运行与验证

```powershell
cd C:\Users\dynas\Documents\Code\NIDE
pnpm dev
```

host 现在是启动必需的，不再需要 `NIDE_HOST`。日志里应能看到
`host process is ready`、`host ready ... ipc=true`、`Host port attached`。
首窗是 host ready **之后**才建的（约 0.4s），所以 `host process is ready` 一定排在
窗口日志前面。

- 主窗口：`main.root` + `zone slots` + demo bundle；
- 欢迎窗口：临时把 `%APPDATA%\NIDE\projects.json` 改名，测完恢复；
- 项目生命周期：换项目（标题栏下拉）、「文件 -> 关闭项目」、列表右键移除；日志里应有
  `project opened` / `project closed` / `project removed from the list`（来自 host）；
- 插件贡献点：启动日志里应有 host 的 `Plugin directories scanned`（**不再有** shell 的
  `Plugin host initialization completed`，那张表已经删了）；视图标题、设置树的子页、
  英文界面都不该退化；
- 本地化：启动日志里有 host 的 `Locale resolved {"locale":"zh-CN",...}`；设置 → 语言
  切到 English 后重建窗口，视图标题 / 设置树 / 原生对话框都应变成英文
  （`src/main/plugin-host` 那条 `Message providers` 日志也在 host 里）。
- 设置窗口：菜单打开，期望 `settings.root registered`；
- Demo：启用 Demo Plugin，打开 `demo.hello`，应出现
  `view served by client modules`；
- 打包后的插件 UI：`pnpm build:plugin-clients && pnpm build:unpack`，用
  `electron.exe dist\win-unpacked\resources\app` 起，`client bundle loaded` 的 `url`
  应是 `nide-plugin://plugin/builtin.demo/client.js`。

常用命令：

```bash
pnpm typecheck
pnpm typecheck:host
pnpm lint
pnpm test                 # 需在普通终端跑
pnpm host:dump
pnpm host:smoke
pnpm build:plugin-clients
pnpm build:unpack        # 打包到 dist/<platform>-unpacked（host 必需，先验这个）
```

### 沙箱限制（重要）

Agent 的执行环境有文件/进程沙箱，以下命令会 `EPERM`，**必须由用户在自己的终端跑**：

- `pnpm install` / `pnpm add`（全局 store 锁 / 删 node_modules）；
- `pnpm test`（vitest 起 esbuild）；
- `pnpm build:plugin-clients`（Vite 在 Windows 上 spawn）；
- 直接启动 Electron GUI。

另外 agent 环境里设了 `ELECTRON_RUN_AS_NODE=1`；跑 Electron 前要
`Remove-Item Env:ELECTRON_RUN_AS_NODE`（用户的普通终端通常没有这个问题）。

## 6. 关键文件

| 文件 | 说明 |
| --- | --- |
| `electron-builder.yml` | 打包：`asar: false`，显式带上 host 源码 / boot / hello / shared / profiles / plugins |
| `src/main/host/process.ts` | spawn host、ready、attach port、`invokeHost`（shell→host RPC）、stop |
| `src/main/host/project.ts` | shell 侧的项目客户端：list / startup / open / forget / close（都走 `invokeHost`） |
| `src/main/window.ts` | 建窗；`boundProjectPath`（主窗口绑定的项目）；`openStartupWindow()` 等 host 的启动结论 |
| `src/main/index.ts` | 启动时拉起 host；`browser-window-created` 挂 port；`will-quit` 停 host |
| `src/main/ipc/project.ipc.ts` | 目录对话框 / 窗口切换 / 二次确认 + 转发到 host |
| `src/main/ipc/host.ipc.ts` | 其余宿主 IPC（插件、主题、i18n、`host:get-client-bundles`） |
| `src/preload/index.ts` | `nideHost` 桥、host 优先回退、`__NIDE_BOOT__` |
| `src/shared/host-rpc/index.ts` | RPC 协议 |
| `packages/host/src/rpc.ts` | RpcRegistry（renderer port 与 shell 父端口共用） |
| `packages/host/src/ipc.ts` | 父端口 / renderer port 的 transport 与 RPC 分发 |
| `packages/host/src/services/project-store.ts` | `projects.json` 的唯一实现：列表 / 当前 / 启动恢复 / 打开 / 移除 / 关闭 |
| `packages/host/src/services/project-files.ts` | host 文件 / 章节 / 伏笔 / 图鉴 / 概述的读写 |
| `packages/host/src/services/project-config.ts` | host 项目配置（load / update / initialize / registry / remap） |
| `packages/host/src/services/plugins.ts` | host 插件清单 / 启停 / client bundle / 本地安装卸载（npm 待做） |
| `packages/host/src/services/plugin-contributions.ts` | host 侧唯一读插件目录的地方：视图 / 设置页 / 语言包 / manifest 词条（路径守卫 + 收敛规则） |
| `packages/host/src/services/i18n.ts` | host 侧本地化：语言包瀑布 / 语言偏好 / `HostI18n` / manifest 标题解析 |
| `packages/client-kit/src` | 客户端共享层：stores / ui / window 外壳 / logger / icons（`@nide/client-kit/*`） |
| `packages/host/src/services/appearance.ts` | host 侧主题 / 外观：`appearance.json` 偏好 + 主题解析（nativeTheme 走反向桥） |
| `packages/host/src/services/ai-provider.ts` | host 侧 AI 供应商：配置 / 测试连接 / SSE 转发 |
| `packages/host/src/services/secrets.ts` | host 侧密钥仓（密文落盘；加解密走 `safeStorage` 反向桥） |
| `src/main/ipc/ai-provider.ipc.ts` | shell 边界：启用检查 + 把分片转给发起窗口（`subscribeHostStream`） |
| `src/main/appearance/index.ts` | shell 的 `AppearanceState` 缓存（窗口底色 / 启动参数要同步） |
| `packages/host/src/services/builtin-views.ts` | 三条内建视图（文件树 / 版本控制 / 提交），标题由 host 按当前语言解析 |
| `src/main/i18n/index.ts` | shell 的载荷缓存 + `t()` + 切语言入口（语言与词条都在 host） |
| `src/main/protocol/plugin-bundles.ts` | `nide-plugin://` 协议：打包后按 pluginId 从 host 清单取 bundle 文件 |
| `src/shared/plugin-api/contributions.ts` | 贡献点的纯数据契约（未解析的 `titleSpec`、插件目录内相对路径） |
| `src/shared/i18n/locale-tag.ts` | 语言标签规范化 + 候选链（自包含，host 也能直接加载） |
| `packages/client-runtime/src/index.ts` | 客户端树、slots/modules、bundle 加载 |
| `packages/client-runtime/src/loader.ts` | bundle 注入：dev 走 `/@fs/`，打包后走 `nide-plugin://` |
| `packages/client-ui-slots/src/index.ts` | `SlotRegistry` / `slotsOf` |
| `packages/client-modules/src/index.ts` | `ClientModuleRegistry` / `modulesOf` |
| `packages/client-ui-renderer/src/index.tsx` | `<SlotProvider>` / `<Slot>` |
| `src/renderer/src/plugins/PluginSlot.tsx` | 先查注册表，再回退 glob |
| `plugins/builtin/demo/src/ui/client-entry.tsx` | bundle 入口 |
| `scripts/build-plugin-client.mjs` | IIFE 构建 |
| `scripts/build-host.mts` | 编译 host 到 `out/host`（TS Node API，不 spawn） |
| `src/shared/project/store.ts` | 纯 store 模型 |
| `src/shared/project/package.json` | ESM 标记 + `#project/*` 子路径导入映射 |
| `src/shared/project/yaml.ts` | 最小 YAML（原 `src/shared/yaml`，搬进 project 包以便 `#project/yaml`） |

## 7. 不可破坏的约定

1. **视觉不变**：不改 JSX class、CSS 变量、尺寸常量、窗口 chrome、默认布局顺序。
2. **不引入 DSH 的 UI/theme/layout 包**；只用 Cordis/loader/slots 等框架层。
3. **React 19 单例**：插件 bundle 外置 React，宿主通过全局提供。
4. **核心 CSS 只有一份**（shell 侧 Tailwind）；插件 CSS 尚未支持。
5. **slot 不产生包装 DOM**；`Slot` 用 `createElement`。
6. **host 不 import electron**；Electron 只能在 shell。
7. **所有新路径都要有回退**：host 直连 port 失败回退 IPC（现在也转发到 host）；
   bundle 失败回退 glob；slot 失败回退 fallback。
8. **不做 Context 模块增强**：Cordis 的 `Context` 是 re-export，会遮蔽原接口。
9. **`src/shared/project` 内的模块之间只用 `#project/*`**：`@shared/*` 是构建期别名、
   免扩展名的相对导入也一样，host 的纯 Node ESM 都解析不了。`package.json#imports`
   是 Node / tsc / Vite 三边都认的那一层（见 `src/shared/project/package.json`）。
10. **host 是必需进程**：文件 / 配置的全部实现都在它里面。打包目前靠
    `asar: false` + `files` 带上 host 源码 / boot / hello / `src/shared` / profiles；
    改回 asar 之前必须先让 host 有编译产物，否则打包版读不到自己的源码。
11. **`projects.json` 只有 host 一份实现**：shell 不要再 import `fs` 去读它，也不要
    在内存里维护「当前项目」。窗口需要的项目路径叫 `boundProjectPath`（主窗口**绑定**
    的那个，建窗时固定），它只能由 host 给的记录写入。
12. **建窗要等 host ready**：`openStartupWindow()` 是 async 的（开主窗口还是欢迎窗口
    取决于 host 读出来的 `projects.json`）。新增「启动时开窗」的入口时别忘了 await
    或 `void`，否则会拿到一个 Promise 而不是窗口。
13. **插件目录只由 host 读**：shell 不要再扫 `plugins/**`、不要再读 `manifest.json`
    或 `package.nls*.json`。视图 / 设置页 / 语言包全部走 `plugins.views` /
    `plugins.settings` / `i18n.*` —— 标题也由 host 解析，shell 不要自己拼 `%key%`。
14. **语言与词条表只住在 host**：shell 只缓存 `I18nPayload`（窗口标题、原生菜单、
    对话框要同步取文案）。新增「需要翻译的 shell 代码」时用 `createMainTranslator()`
    读缓存，不要自己 import 语言包或读 `locale.json`。
15. **`src/shared` 里能被 host 加载的文件必须自包含**：要么没有任何 import（如
    `plugin-api/view.ts`、`i18n/locale-tag.ts`、`i18n/locales/zh-CN.ts`），要么
    import 的是同类自包含文件。跨目录引用 `@shared/*` 在 host 里解析不了；共享目录
    内的相对导入在 NodeNext 下要写 `./x.js`（见 `plugin-api/contributions.ts`）——
    纯类型导入会被擦除，安全。

## 8. 踩过的坑（别再踩）

1. **Cordis Context 增强**：`declare module '@deepseek-ai/cordis' { interface Context { slots } }`
   会让 `plugin` / `effect` 全部丢失。用 `slotsOf(ctx)` / `modulesOf(ctx)` 显式取服务。
2. **Node type stripping 不支持参数属性**：`constructor(private x: string)` 会
   `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`；写成显式字段。
3. **`src/shared` 下的 .ts 被 host 直接 import**：需要在目录里放
   `package.json` `{"type":"module"}`（`src/shared/project`、`src/shared/plugin-api`、
   `src/shared/i18n` 都已经有），并且目录内**不能有 `@shared/*` 或免扩展名的
   相对 import** —— Node ESM 只认 `#project/*`（由同一个 package.json 的 `imports`
   映射到 `./*.ts`）或显式扩展名。
4. **`import.meta.env.DEV` 在 alias 源码里不可靠**：loader 改用
   `window.location.protocol === 'http:'` 判断 dev。
5. **IIFE bundle**：必须 classic JSX（`React.createElement`），React 外置，
   加载时调 `__NIDE_REGISTER__`；否则 `React is not defined` / 注册不上。
6. **`/@fs/` 只在 dev**：生产会走 app 协议（TODO）；
   `loader.ts` 非 dev 会跳过并告警。
7. **`ELECTRON_RUN_AS_NODE=1`**：会让 `electron.exe` 变成 Node，`app` 为 undefined。
8. **pnpm 全局 store 锁**：agent 沙箱无法 `pnpm add`；用户终端跑。
9. **ESLint `static-components`**：动态组件用 `createElement`，别用 `<Component />`。
10. **`WorkbenchLayout` 的 flex**：slot outlet 多一层 div 就会改布局；不要加包装。
11. **`ResizeObserver` 回调链路里不要改被观察元素**：`EditorPanes` 的 `fitBodyHeight`
    曾经在 observer → state → layout effect 的同一轮里写容器高度，浏览器持续报
    `ResizeObserver loop completed with undelivered notifications`。现在的规则是高度
    重算排进下一帧、同一帧只排一次，`chapter-body` 只把宽度变化当重新布局的信号。
12. **未签名的打包 exe 会被 Windows 拦掉**：表现是双击/命令行启动后立刻返回，
    `%APPDATA%\NIDE\logs` 没有任何新行（进程根本没起来）。验证打包内容时用
    `node_modules\electron\dist\electron.exe dist\win-unpacked\resources\app`，
    它加载的是同一份 `resources/app`；发布前再解决签名。
13. **首窗现在要等 host（约 0.4s）**：`openStartupWindow()` 依赖 host 读
    `projects.json`。看不到窗口时先看日志里有没有 `host process is ready` —— 没有就是
    host 没起来，15s 后会回落成欢迎窗口（同时日志里有 `Failed to resolve the startup
    project through host`）。别再在 shell 里加一份 `projects.json` 的读法来「加速启动」，
    那正是上一轮删掉的东西。
14. **自定义协议 + CSP 是两处，缺一不可**：`nide-plugin://` 的 scheme 权限必须在
    `app.whenReady()` **之前**登记（ready 之后登记无效），而页面里的 `<script>` 要能
    加载它，`src/renderer/index.html` 的 `script-src` 里必须有 `nide-plugin:`。
    少任何一处，症状都是「打包后插件视图一片白、Console 里 CSP 或 net::ERR_UNKNOWN_URL_SCHEME」。
15. **`HostI18n` 在 `i18n.init` 之前是中文**：它构造时的 payload 只是中文兜底
    （`locale = zh-CN`）。启动顺序写错（比如先取视图标题、后初始化语言）不会报错，
    只会让第一屏用中文标题 —— shell 那边 `await initI18n()` 必须在开窗之前。
16. **`plugins.views` / `plugins.settings` 的标题依赖当前语言**：切语言后**必须**重建
    窗口（渲染进程会重新拉一次），否则视图标题停在旧语言。切语言那条路已经在
    `recreateRootWindow()` 里，别在别处缓存视图列表。

## 9. 待定的设计问题

- 插件 CSS：禁止自带全局样式 / 提供 `@nide/ui` token / 注入约定，三选一。
- 第三方插件构建：安装时构建还是发布时预构建；pnpm 运行时怎么随包。
- bundle 拆包：协议只认 `/client.js`，需要多文件的插件得自己打成一个文件。
- `PluginSlot` 的 glob 兜底是长期保留还是删掉。
- 视觉回归工具：Playwright + Electron 截图，还是自建 `capturePage`。
- `nide.client` 的正式字段（`views` 映射？`external`？）现在只用了 `bundle`。
- **代码签名**：打包产物未签名，Windows 会直接拦 `nide.exe`。发布前需要证书
  （electron-builder `win.certificateFile` / `certificateSubjectName` + 时间戳）；
  在此之前用 `electron.exe <resources/app>` 验证打包内容。

## 10. 建议的下一会话起手式

> 先读 `docs/architecture/HANDOFF.md`、`cordis-migration.md`、`plugin-ui-bundles.md`。
> 当前状态：项目文件 / 章节 / 伏笔 / 图鉴 / 概述 / 配置 / **项目生命周期（列表 /
> 打开 / 移除 / 关闭）** / **插件的视图 / 设置页 / 语言包 / manifest 词条** /
> **本地化（语言包瀑布 / 偏好 / 标题解析）** / **主题 / 外观** / **AI 供应商与
> 密钥仓** 的 **实现只有一份**，在 host。客户端 slots 与运行时 bundle 在
> **dev 与打包后都可用**（后者走 `nide-plugin://`），UI 未变。打包 `asar: false` +
> 源码 host 已用 `electron.exe <resources/app>` 验证过；`nide.exe` 未签名会被
> SmartScreen 拦。
> **旧实现没有全部迁完**：核心 UI 组件仍在 shell（D1），见 §4.1。
> 下一步按 §4：① 核心 UI 插件化（D1）+ D10；② 发布化（编译 host + asar + 签名）；
> ③ 收尾删掉 shell 的回退路径。npm 安装来源已明确跳过。
> 第十二批可能还没 commit，先看 `git status`。
> 在用户终端跑 `pnpm test` 与 `pnpm dev`（agent 沙箱起不了 vitest / electron-builder）。

## 11. 交接检查清单

- [x] `pnpm typecheck` / `pnpm typecheck:host` 绿（host 工程现在包含
      [test/host](../../test/host) 的 16 份用例）
- [ ] `pnpm test` 重跑：第十批之前是 36 文件；第十 / 十一 / 十二批新增
      `test/host/shell-bridge.test.ts`、`test/host/appearance.test.ts`、
      `test/host/secrets.test.ts`、`test/host/ai-provider.test.ts`、
      `test/shared/theme/theme-data.test.ts`，还没在用户终端跑过
- [x] `pnpm dev` 手工验证：从文件夹安装 → 默认禁用 → 启用信任确认 → 卸载；
      视图 / 设置树同步更新，UI 插件启用后不重启即可显示
- [x] `pnpm dev`：启动自动拉起 host；新建项目生成 `.nide` + 默认图鉴 / 概述预设
- [x] `pnpm dev` 复验第六批（项目生命周期）：启动进主窗口、换项目、关闭项目回欢迎窗口、
      从列表移除、关掉主窗口后重开（不该再问「切换项目」）
- [ ] `pnpm dev` 复验第七 / 九 / 十一 / 十二批（插件贡献点 + 本地化 + 主题 + AI）：
      视图标题、设置树子页、语言切换（中文 <-> English）、换主题（深/浅，窗口底色
      不该露异色）、AI 供应商设置页的读写与测试连接（需要真 key 才测连通）都正常
- [x] **打包后插件 UI**：`pnpm build:unpack` 产物用 `electron.exe
      resources\app` 起，日志里 `client bundle loaded` 的 `url` 是
      `nide-plugin://plugin/builtin.demo/client.js`，随后 `view served by client modules`
      —— 说明协议、CSP、host 清单三处都对上了
- [x] 图鉴 / 概述 / 角色图鉴 / 项目配置读路径正常
- [x] `EditorPanes` 的 ResizeObserver 修复已验证：持续刷屏消失（只剩首次布局的一条）
- [ ] `pnpm lint`：只剩 `scripts/host-ipc-node-smoke.mjs` 的两个
      `explicit-function-return-type`（迁移前就有，与本次改动无关）
- [x] `pnpm build:unpack` 通过：用 `electron.exe dist\win-unpacked\resources\app`
      启动，host ready、新建项目初始化、读写正常（当前 `asar: false` + 源码 host）
- [ ] 代码签名：`nide.exe` 未签名会被 SmartScreen 拦；发布前配 `win.certificateFile`
- [ ] `pnpm build:plugin-clients` 还没在普通终端真跑过一次（agent 沙箱里 esbuild
      `spawn EPERM`）；打包后能加载 bundle 证明**已有**的 `dist/client.js` 是好的
- [ ] `projects.json` 已恢复（测试欢迎窗口时改过名）
- [ ] Demo Plugin 处于启用状态（当前 `disabled:0`）
- [x] 第十七批已提交 `a1b3059`（删 shell 旧实现 + 内建视图搬 host）
- [x] `pnpm typecheck` / `typecheck:host` / `lint` 复跑（第十七批之后）：绿 / 基线
- [x] 编译产物复跑：`node out/host/packages/host/src/index.js --dist-root out/host --once` 正常
- [x] **打包布局模拟过**（不用 electron-builder）：把 `out/host` 与 `plugins/` 拷到
      `<tmp>/app.asar.unpacked/`，用
      `--app-root <tmp>/app.asar.unpacked --dist-root <tmp>/app.asar.unpacked/out/host`
      跑编译产物 —— host ready、3 个内建插件、语言包 309 条、demo 的
      `dist/client.js` 都按打包后的路径解析正确。asar 本体（真的 `app.asar` 与
      Electron 的 asar 文件系统）仍需 `build:unpack` 实测。
- [ ] **等用户验证**：`pnpm test`（新增 `test/host/builtin-views.test.ts`、
      `test/host/secrets.test.ts`、`test/host/ai-provider.test.ts`）、`pnpm dev`（三个窗口 +
      主题 + 语言 + AI 设置页）、`pnpm build:unpack`（asar 与 `app.asar.unpacked`
      布局）。**用户说了先不合并，验证通过再决定。**
- [x] 编译产物实跑：`node out/host/packages/host/src/index.js --dist-root out/host --once`
      通过（profile 从产物里取、hello 插件加载、内建插件扫描到 3 个）
- [ ] `pnpm build:unpack` 复跑（asar 已开）：`resources/app.asar` 存在，
      `resources/app.asar.unpacked/out/host/...` 与 `.../plugins/builtin/...` 存在；
      用 `electron.exe` 起（不能再直接 `electron.exe resources/app`，asar 要走
      `resources/app.asar`），日志里的 host 入口是 unpacked 里的
      `out/host/packages/host/src/index.js`
- [ ] `docs/wiki` 仍为空；需要用户自己 clone Wiki 仓库
