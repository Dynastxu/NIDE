# 客户端文档状态（documents seam）

> 状态：Step 1 已实现（2026-11-21）。
> 目标：让 explorer 与 editor 都不再 import 对方的 store —— 打开哪些文件、当前看哪个、
> 哪些没落盘，统一由 `client-kit` 的文档状态承担；保存后的副作用走事件，不反向依赖
> 具体的功能包。

## 1. 为什么需要它

拆 git 时窗口已经不再 import 具体视图组件；但下一步拆文件树/编辑器时，真正的耦合在
**状态**：

- `explorer.store` 直接 import `editor.store`（打开文件、改名、删除子树）；
- `editor.store` 又被 `editor/`、`shared/entry-*`、`MainMenu` 直接 import；
- `editor-save` 反过来 import `explorer.store` 刷新图鉴列表。

只要这些 import 还在，把 explorer 或 editor 搬出窗口就必然产生
`client-feature → client-window` 的非法依赖。documents seam 把这三条边换成：

```
explorer ─┐
          ├─> client-kit/stores/documents.store
editor  ──┘
                    │
                    └─ notifyDocumentSaved(path, content)
                              └─> explorer（订阅）刷新图鉴
```

## 2. 落了什么

| 位置                                           | 内容                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client-kit` 的 `stores/documents.store.ts`    | 从 `client-ui-main/stores/editor.store.ts` 搬来的 `useDocumentsStore`：`tabs` / `activePath` / `dirty` / `closeQueue` / `pendingDiff`，以及 `openFile` / `setActive` / `requestClose*` / `finishClose` / `setDocument` / `syncFromDisk` / `migratePath` / `closeSubtree` |
| `stores/documents-events.ts`                   | `notifyDocumentSaved(path, content)` / `onDocumentSaved(listener)`：保存后的单向通知                                                                                                                                                                                     |
| `stores/documents-cordis.ts`                   | `installDocuments(ctx)` 提供 `ctx.documents`；`documentsOf(ctx)` 取用（不注入对方包）                                                                                                                                                                                    |
| `client-ui-main/src/index.ts`                  | `mainPlugin.apply` 里 `installDocuments(ctx)`                                                                                                                                                                                                                            |
| `client-ui-main/src/shared/editor-save.ts`     | 保存成功后 `notifyDocumentSaved`，不再 import explorer.store                                                                                                                                                                                                             |
| `client-ui-main/src/stores/explorer.store.ts`  | 订阅 `onDocumentSaved`，图鉴文件的刷新条件从 editor-save 搬到这里                                                                                                                                                                                                        |
| `test/renderer/stores/documents-store.test.ts` | 打开 / 重开 / 脏标记 / syncFromDisk / migratePath / 关闭队列                                                                                                                                                                                                             |

**留在窗口里的**：Monaco model（`shared/model-registry`）、保存实现（`shared/editor-save`）、
编辑器 UI（标签条、表单、diff 浮层）。它们是 editor 的职责，不是「文档状态」——

## 3. 怎么用

React（explorer / editor 都可以直接 import kit，这是平台层，不违反 feature 之间不许
互相 import 的规则）：

```ts
import { useDocumentsStore } from '@nide/client-kit/stores/documents.store'

const activePath = useDocumentsStore((s) => s.activePath)
useDocumentsStore.getState().openFile({ path, name, language, content })
```

非 React 的客户端插件（以后独立成包的 explorer / editor 的 `apply`）：

```ts
export const explorerPlugin = {
  name: 'nide-client-ui-explorer',
  inject: ['slots', 'documents'],
  apply(ctx) {
    const documents = documentsOf(ctx)
    // documents.getState().openFile(...) / documents.subscribe(...)
  }
}
```

保存后的副作用：

```ts
// 保存方（editor 域）
notifyDocumentSaved(path, content)

// 关心方（explorer 域）
const off = onDocumentSaved((path, content) => {
  if (isGalleryFile(path, content)) void useExplorerStore.getState().loadGalleries(true)
})
```

## 4. 不变量

1. **正文只有一份**：Monaco model（`model-registry`）。store 里的 `content` 是推过来的
   副本，`originalValue` 是「与磁盘一致」的基准；保存时先读 model、写盘、再
   `syncFromDisk`。
2. **`dirty` 只由 store 算**：`setDocument` 比较 `content` 与 `originalValue`；保存期间
   用户继续打字时，保存方在 `syncFromDisk` 后再把最新 model 推回 `setDocument`。
3. **保存不 import 具体功能**：保存方只发 `document-saved`；刷新什么由订阅方判断。
4. **`documentsOf` 只看 `ctx`**：功能包之间不 import 对方的 store / 模块；`ctx.documents`
   是唯一跨包入口。
5. **kit 只放 workbench 级状态**：`layout` / `documents` / `gallery` / `overview` 这类
   多域共享状态可以进 `client-kit`；单个窗口专属的业务 UI 状态仍留在窗口包里。

## 5. 已完成：explorer 独立成包

`client-ui-explorer` 已经落成，它验证了这条 seam：

- `ExplorerView` / `ProjectsPanel` / 章节·伏笔动作 / `EntryActionHost` 搬进功能包；
- `explorer.store` 留在功能包（文件树自己的状态），它依赖 kit 的 `documents.store`；
- `gallery.store` / `overview.store` 搬到 `client-kit`（章节表单与图鉴表单也要用），
  explorer 用 `setGalleryLoader` 注册「项目根 + 配置 -> 图鉴目录」，编辑器表单只调
  `ensureGalleries()` —— 两边都依赖 kit，editor 不再 import explorer store；
- 条目动作浮层注册到窗口声明的 `shell.overlay`（list 槽）；
- host 侧 `host.explorer` 描述符从 plugin-runtime 移到 `packages/content`（`files.*` 的
  拥有者），用 `ctx.builtinViews` 登记。

## 6. 下一步

- `client-ui-editor`：editor 域 + `editor-save` + `model-registry` 搬进功能包；注册
  `main.editor`；`MainMenu` 的保存改为经 `ctx.documents` / 公共命令调用。
- 窗口最终只留 `App` / `MainApp` / `WorkbenchLayout` / `ToolZone` / `MainMenu` / chrome。

## 7. 与 DSH 的对应

| DSH                                         | NIDE                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| 客户端服务由功能包 `inject`，store 留在包内 | `ctx.documents` 由窗口安装；explorer/editor 用 `documentsOf(ctx)` 或 kit 的 hook |
| 功能包之间不 import 实现                    | 共享状态进 `client-kit`（平台库），不互相 import                                 |
| 保存等动作通过服务 / 事件解耦               | `document-saved` 单向事件；保存方不认识 explorer                                 |
