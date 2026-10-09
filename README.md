# NIDE — Novel IDE

AI 辅助的**小说工程化** IDE 编辑器。

技术选型：Electron（客户端框架）+ Monaco（编辑器）+ TypeScript。

> **项目处于初期。** 完整的架构说明、功能现状与开发约定见
> [Wiki](https://github.com/Dynastxu/NIDE/wiki)，本文件只保留项目说明与上手所需内容。

## 目标

| 方向              | 内容                                                   |
| ----------------- | ------------------------------------------------------ |
| 基础 IDE          | 文本编辑、Git 版本管理等                               |
| 插件宿主          | 一切能力以插件形式扩展                                 |
| AI Agent 辅助写作 | 作为**内置插件**：文笔优化、写作建议与规划、一致性检查 |
| 小说架构          | 项目说明、大纲、世界观、人物说明、伏笔管理、章节概述   |

## 现状

已落地：工作台骨架（IDEA 式七分区布局，布局持久化到 localStorage）、Monaco 集成
（编辑器与 Diff 对比视图）、自定义窗口骨架（无边框 + 自绘标题栏）、插件宿主
（扫描插件目录、注册视图贡献点与权限、沙箱文件 API）、四层本地化机制、设置窗口
（左树 + 右页），以及 typecheck / lint / 测试三门禁。

尚未实现：Git 版本管理、AI Agent 插件（`plugins/builtin/ai-agent/` 目前是**空目录**）、
小说架构的数据模型与界面、插件后端沙箱、插件市场、插件卸载与启用状态的持久化、
「项目设置」。

逐条清单（含具体文件位置）见 [项目现状](https://github.com/Dynastxu/NIDE/wiki/Project-Status)。

## 环境要求

- **Node**：仓库的工具链（install / typecheck / lint）只在 **Node 24.21.0** 上跑过。
- npm

应用**运行时不受系统 Node 影响** —— Electron 自带 Node 与 V8，系统 Node 只服务于构建和
测试工具（Vite / Vitest / ESLint / tsc）。所以换 Node 版本出问题，坏的是工具链，不是应用
本身。依赖声明的范围与 `engines` 的处理见
[开发与命令](https://github.com/Dynastxu/NIDE/wiki/Development)。

## 快速开始

```bash
npm install
npm run dev          # 开发（HMR）
npm run check        # 门禁：类型检查 + lint + 测试
npm run build:win    # 打包（另有 build:mac / build:linux）
```

## 命令

| 命令                                    | 作用                                                          |
| --------------------------------------- | ------------------------------------------------------------- |
| `npm run dev`                           | 启动开发环境（HMR）                                           |
| `npm run check`                         | `typecheck` + `lint` + `test`；`build` 与 CI 都走它           |
| `npm test` / `test:watch`               | 跑测试 / 监听模式                                             |
| `npm run typecheck`                     | 分别检查 node 侧与 web 侧两个 TS 工程                         |
| `npm run lint` / `format`               | ESLint / Prettier                                             |
| `npm run build`                         | 跑门禁后构建主进程 / 预加载 / 渲染三份 bundle，**不出安装包** |
| `npm run build:win` / `:mac` / `:linux` | 在 `build` 基础上用 electron-builder 出对应平台安装包         |
| `npm run build:unpack`                  | 只出解包目录（`--dir`），调试用                               |

## 文档

详情参见 [Github Wiki](https://github.com/Dynastxu/NIDE/wiki)
