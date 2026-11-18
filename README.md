<h1 align="center">NIDE</h1>

<p align="center">
  <a href="LICENSE">
    <img alt="AGPL v3" src="https://img.shields.io/badge/LICENSE-AGPL%20v3-blue?logo=gnu">
  </a>
</p>

<p align="center">
  <a>
    <img alt="WebStorm" src="https://img.shields.io/badge/WebStorm-blue?logo=webstorm">
  </a>
  <a>
    <img alt="Git" src="https://img.shields.io/badge/Git-blue?logo=git&logoColor=white">
  </a>
  <a>
    <img alt="electron" src="https://img.shields.io/badge/electron-blue?logo=electron&logoColor=white">
  </a>
  <a>
    <img alt="Prettier" src="https://img.shields.io/badge/Prettier-blue?logo=prettier&logoColor=white">
  </a>
  <a>
    <img alt="Tailwind CSS" src="https://img.shields.io/badge/Tailwind%20CSS-blue?logo=tailwindcss&logoColor=white">
  </a>
  <a>
    <img alt="ESLint" src="https://img.shields.io/badge/ESLint-blue?logo=eslint&logoColor=white">
  </a>
  <a>
    <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-blue?logo=typescript&logoColor=white">
  </a>
</p>

---

AI 辅助的**小说工程化** IDE。

技术栈：Electron + React + Monaco + TypeScript；运行时用 [Cordis](https://github.com/cordiverse/cordis)
把宿主与客户端都组织成插件树。

> **项目处于初期。** 本文件只放项目说明与上手；架构、插件协议与边界以
> [docs/architecture](docs/architecture) 和代码为准（Wiki 已不再维护）。

## 目标

| 方向              | 内容                                                   |
| ----------------- | ------------------------------------------------------ |
| 基础 IDE          | 文本编辑、Git 版本管理等                               |
| 插件宿主          | 一切能力以插件形式扩展                                 |
| AI Agent 辅助写作 | 作为**内置插件**：文笔优化、写作建议与规划、一致性检查 |
| 小说架构          | 项目说明、大纲、世界观、人物说明、伏笔管理、章节概述   |

## 架构一览

- **host 进程**：`utilityProcess.fork` 出的独立 Node 进程，跑 Cordis 树；业务服务
  （project / content / config / plugin-runtime / i18n / appearance / secrets / ai）
  都是插件，彼此用 `ctx.<service>` + `inject` 取用；
- **装配**：profile 的 `package.json` 列组合包（`packages/bundle/base`），再叠
  `cordis.yml` 与用户 `cordis.patch.yml`；按 `id` 覆盖，改配置就能换能力；
- **客户端**：渲染进程里也是一棵 Cordis 树；每个界面包在 `package.json` 声明
  `nide.client.windowTypes`，由生成的花名册按窗口懒加载；
- **插件包**：`packages/plugins/*` 带 `manifest.json`（贡献点 + 权限），可选后端在
  子进程里跑；安装 = 目录 + profile 里一行，选择记在装配里；
- **安全边界**：插件权限在宿主 RPC 入口检查；后端 `sandboxed` 时由 Node
  `--permission` 强制文件与子进程权限；桌面能力单独按 `os.*` 授权（见
  [plugin-permissions](docs/architecture/plugin-permissions.md)）。

## 现状

已落地：IDEA 式七分区工作台（布局持久化）、Monaco 编辑器与 Diff、无边框自定义窗口、
设置窗口与欢迎窗口、四层本地化、插件宿主管线（清单 / 贡献点 / 视图与设置页 / 语言包 /
启停偏好）、mics 式权限声明（trust / fs / net / os / exec，RPC 拦截 + 后端引擎强制）、
插件后端 worker、激活事件与依赖、安装升级事务与卸载脚本、每插件存储、受控桌面能力、
插件装配分层（bundle / profile / 用户 patch）以及 typecheck / lint / 测试三门禁。

尚未实现：Git 版本管理（目前只有占位视图）、AI Agent 插件（`ai-provider` 目前只提供
供应商设置）、小说架构的数据模型与界面、插件市场、npm 源安装、插件 UI 沙箱
（见 [#6](https://github.com/Dynastxu/NIDE/issues/6)）。

## 仓库结构

```
apps/desktop/            Electron 应用（main / preload / renderer 入口）
packages/
  contracts/             跨进程契约：类型 + 纯函数 + 词条基础表
  kernel/ boot/ host/    Cordis 上下文、profile 引导、host 进程入口
  shell/                 Electron 外壳（窗口 / 菜单 / 协议 / IPC）
  project/ content/ config/ plugin-runtime/ i18n/ appearance/ secrets/ ai/
  plugins/<name>/        NIDE 插件包（demo / lang-en / ai-provider）
  sdk/ client-kit/ client-runtime/ client-ui-*/ client-modules/ client-ui-slots/
  bundle/base/           组合包：宿主服务的 patch 行
docs/architecture/       架构、插件协议与长期交接
```

profile 不在仓库里：首次启动由 `packages/boot` 用代码生成到 `NIDE_HOME/profiles/<name>`。

## 环境要求

- **Node 24.21.0**（工具链只在这个版本上验证过）、pnpm；
- 应用运行时用 Electron 自带的 Node/V8，系统 Node 只服务构建、类型检查与测试。

## 快速开始

```bash
pnpm install
pnpm run dev          # 开发（HMR）
pnpm run check        # 门禁：typecheck + lint + test
pnpm run build:win    # 打包（另有 build:mac / build:linux）
```

## 文档

- [架构与插件协议](docs/architecture)：权限、后端 worker、生命周期、客户端 bundle、
  装配分层、迁移与交接；
- 包一级的约定见 [packages/AGENTS.md](packages/AGENTS.md)，插件运行时见
  [packages/plugin-runtime/AGENTS.md](packages/plugin-runtime/AGENTS.md)；
- 历史决策与踩坑记录在 [HANDOFF](docs/architecture/HANDOFF.md)（按时间累积，读最新段落）。
