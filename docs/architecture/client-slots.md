# 客户端 slot 模型升级（对齐 DSH）

> 状态：Step 1–4 已实现（2026-11-21）。
> 目标：把 `client-ui-slots` 从「只有 single 的组件表」升级到 DSH 的
> `single / keyed / list` 三种槽 + 声明 + 订阅，为 explorer / editor 拆包提供前置。
> 参考：DSH 的 `packages/client/ui-layout/src/client/index.ts`（声明子槽、`main` 为
> keyed、`shell.overlay` 为 list、`ctx.slots.entries/subscribe`）与
> `packages/client/ui-sidebar-files/src/client/index.ts`（功能包自己 `apply(ctx)`、
> 自己的 store 留在包内、只通过服务与槽交互）。

## 1. 为什么现在做

git 视图迁移证明了「窗口不 import 组件」是可行的：窗口只按 `hostViewSlotName(id)`
查 slot。但下一步（文件树 / 编辑器）会撞到两个缺口：

1. **槽只有 single**：中间编辑区、窗口级浮层这类位置需要 keyed / list；
2. **没有订阅**：功能包可能在首帧之后才挂载（插件 bundle 动态加载、未来的按需功能），
   `Slot` 现在只读一次注册表，晚注册的 occupant 不会出现。

这两件事都在 `client-ui-slots`，所以先升级它，再搬功能包。

## 2. 现状与差距

```ts
// packages/client-ui-slots/src/index.ts（现状）
export type SlotComponent = ComponentType<Record<string, never>>

export class SlotRegistry {
  private readonly slots = new Map<string, SlotComponent[]>()
  register(name: string, component: SlotComponent): () => void
  get(name: string): SlotComponent | undefined // 永远取第一个
  count(name: string): number
}
```

| 位置                                           | 现在的做法                                     | 需要的能力                                |
| ---------------------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| `main.root` / `settings.root` / `welcome.root` | single，第一个生效                             | 保持 single                               |
| `zone.*`                                       | single，占位者 `ToolZone` 自己再按视图 id 分发 | 保持 single                               |
| `view.host.*`                                  | single，功能包注册一个组件                     | 保持 single                               |
| 中间编辑区（未来 `main.editor`）               | `WorkbenchLayout` 直接 import `EditorTabs`     | keyed / single 二选一，先把 import 换成槽 |
| 窗口级浮层（`EntryActionHost` 等）             | `MainApp` 直接 mount                           | list，按 order 叠加                       |

插件视图**不在**这次范围里：它们走 `ClientModuleRegistry` + `PluginSlot`（bundle 在运行时
注册组件），与宿主/功能包的 slot 是两条路；这次不合并。

## 3. 目标 API

### 3.1 类型

```ts
export type SlotKind = 'single' | 'keyed' | 'list'

export interface SlotEntry {
  readonly component: SlotComponent
  /** keyed 槽的 key；single / list 为 undefined */
  readonly key?: string
  /** list 的排序；同 order 按注册先后 */
  readonly order: number
  /** 排障用；默认取组件 displayName / name */
  readonly id: string
}

export interface SlotRegistration {
  name: string
  /** keyed 必填；single / list 不允许 */
  key?: string
  /** list / keyed 的排序，默认 0 */
  order?: number
  /** 稳定 id（日志、replace 判定）；省略时自动生成 */
  id?: string
}
```

### 3.2 注册表

```ts
export class SlotRegistry {
  /**
   * 声明一个槽的种类。父包（窗口）在 apply 里调用一次。
   * 未声明的槽默认 `single` —— 现有调用点零改动。
   * 同一声明重复调用：kind 相同幂等，不同则抛错（装配错误要在启动期暴露）。
   * 声明随这个 SlotRegistry（这扇窗的客户端树）一起销毁，不单独撤销。
   */
  declare(name: string, kind: SlotKind): void

  /** 旧签名：等价于 register({ name }, component)，single 语义 */
  register(name: string, component: SlotComponent): () => void

  /** 新签名：keyed / list 用它；single 也接受（忽略 key/order） */
  register(registration: SlotRegistration, component: SlotComponent): () => void

  /** single：第一个注册者（与现在一致） */
  get(name: string): SlotComponent | undefined

  /** keyed：按 key 取；同一 key 后注册覆盖先注册 */
  getKeyed(name: string, key: string): SlotComponent | undefined

  /** list：按 order + 注册顺序 */
  list(name: string): readonly SlotEntry[]

  /** 全部 entry（含 single / keyed），调试与渲染共用 */
  entries(name: string): readonly SlotEntry[]

  /** 已声明的种类；未声明返回 'single' */
  kindOf(name: string): SlotKind

  /** 当前快照。同一版本内返回同一个引用，供 useSyncExternalStore 使用 */
  snapshot(name: string): readonly SlotEntry[]

  /** 订阅某个槽的变化；返回取消订阅 */
  subscribe(name: string, listener: () => void): () => void

  /** 调试：数量（保留现有调用） */
  count(name: string): number
}
```

### 3.3 语义细则

- **single**：`get` 取第一个；重复注册按现有行为（先注册者生效），注销时移除自己。
- **keyed**：同一 `key` 后注册覆盖；不同 key 并存；`register` 时没有 `key` 直接抛错。
  被覆盖的旧 occupant 的注销函数是**无操作**，不能把新 occupant 删掉。
- **list**：全部保留；按 `order` 升序，`order` 相同按注册顺序；`register` 时带 `key` 抛错。
- **order**：只对 keyed / list 有意义；single 忽略 key / order（旧签名零改动）。
- **快照**：每个槽维护一个版本号；`entries/snapshot` 在版本未变时返回**同一个数组引用**，
  避免 React 在 `useSyncExternalStore` 里无限重渲染。
- **订阅**：注册 / 注销 / 覆盖 key 都触发一次对应槽的 listener；listener 抛错不影响其他
  listener（逐个 try/catch，记日志）。
- **注销**：返回的函数可重复调用；注销后对应 entry 从快照移除，并触发订阅。
- **未声明**：默认 single；如果之后被声明为 keyed / list，按新种类重新解释已有 entry
  （不丢注册），但只允许在首次渲染前发生 —— 这是装配顺序约束，测试会钉住。

### 3.4 React 渲染

`Slot` 保持一个入口，按声明种类决定行为；**不产生包装 DOM**（与现在一致）：

```tsx
<Slot name="zone.leftTop" fallback={<ToolZone id="leftTop" />} />
<Slot name="main.editor" fallback={<EditorTabs />} />
<Slot name="shell.overlay" />                    {/* list：按 order 全部渲染 */}
<Slot name="main" activeKey={activeMainPanelId} fallback={<Empty />} />
```

```ts
// 纯函数，便于单测（不依赖 React）
export function resolveSlot(
  kind: SlotKind,
  entries: readonly SlotEntry[],
  activeKey?: string
): readonly SlotEntry[] {
  if (kind === 'single') return entries.slice(0, 1)
  if (kind === 'keyed')
    return activeKey === undefined ? [] : entries.filter((e) => e.key === activeKey)
  return entries
}
```

`Slot` 内部用 `useSyncExternalStore` 订阅 `registry.subscribe(name, ...)`，快照取
`registry.snapshot(name)`；`activeKey` 变化时用 `resolveSlot` 重新选择。keyed 没有匹配
key 时渲染 `fallback`，避免「切到不存在的面板」时整块空白。

## 4. 迁移步骤（每步行为不变）

### Step 1：注册表 + 渲染器

- 改 `client-ui-slots`：类型、声明、注册重载、快照、订阅、`resolveSlot`；
- 改 `client-ui-renderer`：`Slot` 支持 `activeKey`，按 declaration 渲染 single / keyed / list；
- 现有调用点一行不改（旧签名保留）；
- 单测：single 兼容、keyed 覆盖、list 排序、订阅通知、快照引用稳定、非法注册抛错。

### Step 2：窗口声明新槽（fallback 保行为）

- `client-ui-main` 的 `mainPlugin.apply` 里声明：
  - `main.editor` → `single`（编辑区只有一个 occupant；将来需要多面板再改 keyed）
  - `shell.overlay` → `list`
- `WorkbenchLayout`：`<EditorTabs />` → `<Slot name="main.editor" fallback={<EditorTabs />} />`；
- `MainApp`：`<EntryActionHost />` → `<Slot name="shell.overlay" fallback={<EntryActionHost />} />`；
- 此时 fallback 就是旧组件，界面零变化。

### Step 3：EntryActionHost 进功能包（已完成）

- explorer 包注册 `shell.overlay`（`EntryActionHost`）与 `view.host.explorer`；
- 窗口删掉 `EntryActionHost` 的静态 import，`MainApp` 只留 `<Slot name="shell.overlay" />`。

### Step 4：编辑器进功能包（已完成）

- `client-ui-editor` 注册 `main.editor`（EditorTabs）与 `shell.overlay`（MonacoDiffView），
  并注册 `editor.save` 命令；
- `WorkbenchLayout` 删掉 `EditorTabs` / `MonacoDiffView` 的 import，中间区只剩
  `<Slot name="main.editor" />`；
- `MainMenu` 的保存改为 `runCommand('editor.save')`，窗口不再 import 编辑器实现。

## 5. 测试与门禁

- `test/renderer/client-slots.test.ts`（新增）：注册表语义 + `resolveSlot`；
- 现有 `test/renderer/client-roster.test.ts` 不受影响；
- `pnpm typecheck`、`lint:imports`、`lint:domains`、`pnpm test`、`format:check`；
- 行为验收：`pnpm dev` 打开主窗口，六个区 / 文件树 / 版本控制 / 提交与改前逐像素一致
  （或至少截图 diff 为 0）；插件视图（demo）仍正常加载。

## 6. 不做什么

- **不加 slot props / `inject` face**：DSH 的 occupant 会拿到 `store` / `hooks` / `locale`，
  NIDE 现在组件都是零 props；等 explorer/editor 真正需要共享状态时再加，避免一次改太多。
- **不加 session scope**：NIDE 客户端没有 Session 概念，全部 `scope: 'root'`。
- **不合并 plugin 视图**：`PluginSlot` / `ClientModuleRegistry` 保持原样。
- **不做 HMR**：注册表变更后的热替换另开。
- **不把 `zone.*` 改成 keyed**：`ToolZone` 继续作为 single occupant 内部切视图；
  DSH 的左侧栏也是 single slot + 内部 tab，不是每个视图一个槽。

## 7. 风险

| 风险                                             | 处理                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `useSyncExternalStore` 快照不稳定导致重渲染循环  | 每个槽缓存数组，只有变更才换引用；单测断言两次 `snapshot` 引用相同 |
| keyed 覆盖语义与 single 的「先注册者生效」不一致 | 文档写死；测试分别钉住；UI 上层不依赖覆盖顺序                      |
| 晚注册的 occupant 与首帧顺序冲突                 | 订阅 + `subscribe` 通知；窗口声明必须在首帧前完成（测试校验）      |
| 功能包误用未声明的 keyed 槽                      | 未声明默认 single；keyed 注册不带 key 抛错；日志带槽名与包名       |
| 旧调用点回归                                     | 旧 `register(name, component)` 签名保留，现有测试全绿              |

## 8. 验收清单

- [x] `SlotRegistry` 支持 `single / keyed / list`，旧签名零改动可用；
- [x] `Slot` 按声明渲染，keyed 支持 `activeKey`，list 按 order；
- [x] `subscribe` + 稳定快照通过测试；
- [x] `main.editor` / `shell.overlay` 用 fallback 接入后行为不变（Step 2）；
- [x] `pnpm check` 全绿（含新增单测）；
- [x] `docs/architecture/plugin-first-layout.md` 与 `packages/AGENTS.md` 补一句槽模型链接。

## 9. 与 DSH 的对应关系

| DSH                                               | NIDE 目标                                   | 差异                                                   |
| ------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------ |
| `ctx.slots.register({ name, key }, Component)`    | `register({ name, key, order }, component)` | NIDE 先不加 `locale` / `inject` / `store`              |
| 父包 `register` 时声明 `children`                 | `ctx.slots.declare(name, kind)`             | 拆成显式声明，便于窗口单独管理                         |
| `ctx.slots.entries('main')` / `subscribe('main')` | `entries` / `snapshot` / `subscribe`        | 语义对齐                                               |
| `main` 为 keyed、`shell.overlay` 为 list          | 同                                          | 先以 `main.editor` single 落地，keyed 留给未来多主面板 |
| 功能包 `inject` 服务、store 在包内                | 同（后续 explorer/editor 方案）             | 服务层不在本方案内                                     |

## 10. 实现落点

### Step 1（注册表 + 渲染器）

- [`packages/client-ui-slots/src/index.ts`](../../packages/client-ui-slots/src/index.ts)：
  `declare` / 重载 `register` / `getKeyed` / `list` / `entries` / `snapshot` /
  `subscribe` / `resolveSlot`；未声明槽默认 single。
- [`packages/client-ui-renderer/src/index.tsx`](../../packages/client-ui-renderer/src/index.tsx)：
  `Slot` 用 `useSyncExternalStore` 订阅，支持 `activeKey`，single / keyed / list 共用
  一个入口，不产生包装 DOM。
- [`test/renderer/client-slots.test.ts`](../../test/renderer/client-slots.test.ts)：
  三种语义、非法注册、快照稳定性、订阅、`resolveSlot`。
- `SlotComponent` 的 props 类型从 `Record<string, never>` 改成
  `Record<never, never>`：list 渲染时 `createElement` 需要带 React `key`，原来的
  索引签名会把 `key` 推成 `never`。组件仍然不能接收业务 props。

### Step 2（窗口声明槽 + fallback）

- [`packages/client-ui-main/src/index.ts`](../../packages/client-ui-main/src/index.ts)：
  `declare('main.editor', 'single')`、`declare('shell.overlay', 'list')`。
- [`packages/client-ui-main/src/layout/WorkbenchLayout.tsx`](../../packages/client-ui-main/src/layout/WorkbenchLayout.tsx)：
  中间区换成 `<Slot name="main.editor" fallback={<EditorTabs />} />`。
- [`packages/client-ui-main/src/MainApp.tsx`](../../packages/client-ui-main/src/MainApp.tsx)：
  浮层换成 `<Slot name="shell.overlay" fallback={<EntryActionHost />} />`。
- 两处 fallback 就是原来的组件，DOM 与视觉不变；Step 3/4 已按此收尾：`MainApp` 只剩
  `<Slot name="shell.overlay" />`，`WorkbenchLayout` 只剩 `<Slot name="main.editor" />`。

### Step 3（explorer 注册浮层）

- [`packages/client-ui-explorer/src/index.ts`](../../packages/client-ui-explorer/src/index.ts)：
  注册 `view.host.explorer` 与 `shell.overlay`（EntryActionHost）；
- 窗口删掉 `EntryActionHost` 的静态 import。

### Step 4（editor 注册主区与保存命令）

- [`packages/client-ui-editor/src/index.ts`](../../packages/client-ui-editor/src/index.ts)：
  注册 `main.editor`（EditorTabs）、`shell.overlay`（MonacoDiffView）与 `editor.save` 命令；
- [`packages/client-ui-main/src/layout/WorkbenchLayout.tsx`](../../packages/client-ui-main/src/layout/WorkbenchLayout.tsx)：
  中间区只剩 `<Slot name="main.editor" />`；
- [`packages/client-ui-main/src/window/MainMenu.tsx`](../../packages/client-ui-main/src/window/MainMenu.tsx)：
  保存改为 `runCommand('editor.save')`（client-kit 命令表）。
