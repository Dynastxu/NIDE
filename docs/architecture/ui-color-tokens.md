# UI 配色：语义 token

界面里的颜色**只有一个来源**：`apps/desktop/renderer/src/assets/index.css` 的 `@theme`
块。组件写角色名（`bg-surface` / `text-fg-muted` / `border-line`），编译出来是
`var(--color-…)`；浅色主题在 `assets/light.css` 里覆盖同一组变量，不写第二条选择器规则。

这套结构是替代「组件写原始色阶 + 浅色主题逐条翻译」的旧方案。旧方案的失败模式值得记着：
翻译表覆盖不到变体（`hover:` / `disabled:` / `focus:`），漏一条不报错 —— 浅色下悬停会闪出
一块深灰，成功提示的绿字压在白底上基本看不见。实际漏了 24 个类。

## token 表

| 组   | token                           | 深色                             | 浅色                  | 用在哪                                      |
| ---- | ------------------------------- | -------------------------------- | --------------------- | ------------------------------------------- |
| 面   | `panel`                         | `#09090b`                        | `#fafafa`             | 侧栏、标题栏、页脚、视图头（比画布沉一档）  |
|      | `surface`                       | `#18181b`                        | `#ffffff`             | 画布、窗口内容底（= `THEME_WINDOW_COLORS`） |
|      | `raised`                        | `#27272a`                        | `#ffffff`             | 浮层、菜单、对话框、输入框                  |
|      | `subtle`                        | `#27272a`                        | `#f4f4f5`             | 行悬停、徽章、禁用底                        |
|      | `control`                       | `#3f3f46`                        | `#e4e4e7`             | 次要按钮、胶囊                              |
|      | `control-hover`                 | `#52525b`                        | `#d4d4d8`             | 次要按钮悬停                                |
| 线   | `line-subtle`                   | `#27272a`                        | `#e4e4e7`             | 区块之间的淡分界                            |
|      | `line`                          | `#3f3f46`                        | `#d4d4d8`             | 卡片、菜单、表格                            |
|      | `line-strong`                   | `#52525b`                        | `#a1a1aa`             | 输入框、悬停中的边框                        |
| 字   | `fg`                            | `#e4e4e7`                        | `#18181b`             | 标题与正文                                  |
|      | `fg-muted`                      | `#a1a1aa`                        | `#52525b`             | 说明、行内标签                              |
|      | `fg-subtle`                     | `#71717a`                        | `#71717a`             | 占位符、路径、时间戳                        |
|      | `fg-disabled`                   | `#52525b`                        | `#a1a1aa`             | 禁用文字                                    |
| 主色 | `accent`                        | `#2563eb`                        | `#2563eb`             | 主色实心面                                  |
|      | `accent-hover`                  | `#3b82f6`                        | `#1d4ed8`             | 主色实心面悬停                              |
|      | `accent-fg`                     | `#60a5fa`                        | `#1d4ed8`             | 淡底上的文字 / 图标、链接                   |
|      | `on-accent`                     | `#ffffff`                        | `#ffffff`             | 压实心面上的字                              |
| 危险 | `danger` / `danger-hover`       | `#dc2626` / `#ef4444`            | 同 / `#b91c1c`        | 危险按钮                                    |
|      | `danger-fg`                     | `#f87171`                        | `#b91c1c`             | 错误文字                                    |
|      | `danger-line` / `danger-soft`   | `#7f1d1d` / `rgb(69 10 10 / .4)` | `#fca5a5` / `#fef2f2` | 错误条描边 / 底                             |
| 警示 | `warning`                       | `#fbbf24`                        | `#b45309`             | 未保存圆点、图标                            |
|      | `warning-strong`                | `#fde68a`                        | `#78350f`             | 提示条文字                                  |
|      | `warning-line` / `warning-soft` | `#78350f` / `#451a03`            | `#fcd34d` / `#fffbeb` | 提示条描边 / 底                             |
| 成功 | `success`                       | `#34d399`                        | `#047857`             | 成功提示（只有这一档）                      |
| 其它 | `scrim`                         | `rgb(0 0 0 / .5)`                | `rgb(0 0 0 / .35)`    | 模态遮罩                                    |
|      | `shade`                         | `rgb(0 0 0 / .45)`               | `rgb(0 0 0 / .15)`    | 浮层投影色                                  |
|      | `scrollbar`                     | `#3f3f46`                        | `#a1a1aa`             | 滚动条滑块                                  |
|      | `inset`                         | `#27272a`                        | `#f4f4f5`             | Markdown 行内代码、表头                     |

## 规则

1. **不写原始色阶**。`bg-zinc-800` 这类类名等于在组件里写死一套配色，浅色主题立刻漏翻。
2. **交互层要有自己的 token**，不靠透明度凑。透明度是相对父层的数学：深色下"提亮"的
   60% 压到白底上几乎不可见。所以悬停用 `subtle` / `control`，选中用 `accent/20`，而不是
   `bg-surface/40` 这种「看起来差不多」的写法。
3. **加一个颜色 = 两处各一行**（`index.css` 的 `@theme` + `light.css`），浅色值必须与深色
   不同 —— 只有 `accent`、`on-accent`、`danger`、`fg-subtle` 四个例外（实心面压白字两种配色
   都成立；`fg-subtle` 是中性中间调，一档灰在两边都站得住）。
4. **浅色下 `surface` / `raised` 都是纯白**：靠底色区分的容器必须自带 `border-*` 或
   `shadow-shade`，否则会消失在白色画布上。徽章、胶囊用 `subtle` / `control`，不要用 `raised`。
5. **语义色成组**：`-soft`（底）、`-line`（描边）、`-fg`（字）、实心面 + `on-accent`（字）。
   深色下是"深底浅字"，浅色下整组换成"浅底深字"，不要只翻其中一项。

## 校验

`test/renderer/color-tokens.test.ts` 守四件事：两套 token 成对、该变的值都变了、源码里没有
原始色阶、浅色主题只有一个规则块（防止退回逐条翻译）。`test/renderer/scrollbar-theme.test.ts`
另外守滚动条那条全局规则。

## 已知取舍

- 深色 `fg-subtle`（`#71717a`）压在 `surface` 上是 **3.67:1**，低于 AA 的 4.5:1 —— 迁移前
  `text-zinc-500` 就是这个值，属于"提示文字"的既有取舍。要达标需要亮到 `#8b8b93` 左右，
  会让 83 处提示文字明显变亮，所以留作单独的设计决定。
- **Monaco 仍用自带主题**（`vs` / `vs-dark`），没接这套 token：`editor/monaco-theme.ts` 的注释里
  写了下一步（`defineTheme` + token 值），属于纯增量改动。
- **插件不能贡献主题**：配色已经是变量，缺的只是把插件提供的值注入进来的机制。
