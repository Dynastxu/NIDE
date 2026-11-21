import type { ComponentType } from 'react'
import type { Context } from 'cordis'

/**
 * 具名插槽注册表（纯逻辑，不依赖 React 运行时）。
 *
 * 三种语义，对齐 DSH 的 slots：
 *
 * - `single`：第一个注册者生效（现有 `main.root` / `zone.*` / `view.host.*`）；
 * - `keyed`：按 key 取，同一 key 后注册覆盖（主面板 / 多 occupant 的同一位置）；
 * - `list`：全部保留，按 `order` 再按注册顺序（窗口级浮层）。
 *
 * 槽的种类由父包用 `declare(name, kind)` 声明；**未声明的槽默认 single**，
 * 所以旧调用点（`register(name, component)`）不需要改。
 *
 * 注册表还提供 `snapshot` + `subscribe`：渲染侧用 `useSyncExternalStore` 订阅，
 * 晚注册的功能包也能出现，而不是首帧读一次就定死。
 *
 * 注意：这个文件只有 `import type`，所以 host / 非 React 环境 import 它也不会
 * 把 React 拖进 bundle。
 */

export type SlotComponent = ComponentType<Record<never, never>>

export type SlotKind = 'single' | 'keyed' | 'list'

/** 一个已注册的 occupant。`id` 只用于排障与 React key，不参与选择。 */
export interface SlotEntry {
  readonly id: string
  readonly component: SlotComponent
  /** keyed 槽的 key；single / list 为 undefined */
  readonly key?: string
  /** list 的排序；同 order 按注册先后 */
  readonly order: number
}

export interface SlotRegistration {
  name: string
  /** keyed 必填；single / list 不允许 */
  key?: string
  /** list / keyed 的排序，默认 0 */
  order?: number
  /** 稳定 id（日志 / React key）；省略时自动生成 */
  id?: string
}

interface SlotState {
  kind: SlotKind
  /** 是否被显式声明过；未声明时默认 single，可被 declare 升级 */
  declared: boolean
  entries: SlotEntry[]
  snapshot: readonly SlotEntry[]
  listeners: Set<() => void>
  sequence: number
}

const NO_ENTRIES: readonly SlotEntry[] = Object.freeze([])

export class SlotRegistry {
  private readonly slots = new Map<string, SlotState>()

  /**
   * 声明槽的种类。窗口包在 `apply` 里调用一次。
   *
   * 声明随这个 `SlotRegistry`（也就是这扇窗的客户端树）一起销毁，不单独撤销。
   * 重复声明同一种类幂等；换成另一种类抛错 —— 装配错误要在启动期暴露。
   */
  declare(name: string, kind: SlotKind): void {
    const state = this.state(name)
    if (state.declared) {
      if (state.kind !== kind) {
        throw new Error(`slot "${name}" is already declared as ${state.kind}, not ${kind}`)
      }
      return
    }

    // 未声明时可能已经有 occupant；升级种类要保证已有注册仍然合法。
    if (kind === 'keyed' && state.entries.some((entry) => entry.key === undefined)) {
      throw new Error(`slot "${name}" has occupants without a key; cannot declare it as keyed`)
    }
    if (kind === 'list' && state.entries.some((entry) => entry.key !== undefined)) {
      throw new Error(`slot "${name}" has keyed occupants; cannot declare it as list`)
    }

    state.kind = kind
    state.declared = true
    if (kind === 'list') state.entries.sort(byOrder)
    this.commit(state)
  }

  /** 注册一个 slot occupant；返回注销函数（可直接交给 ctx.effect）。 */
  register(name: string, component: SlotComponent): () => void
  register(registration: SlotRegistration, component: SlotComponent): () => void
  register(nameOrRegistration: string | SlotRegistration, component: SlotComponent): () => void {
    const registration =
      typeof nameOrRegistration === 'string' ? { name: nameOrRegistration } : nameOrRegistration
    const { name } = registration

    if (!name) throw new Error('slots.register requires a slot name')
    if (typeof component !== 'function') {
      throw new Error(`slots.register("${name}") requires a component`)
    }

    const state = this.state(name)

    if (state.kind === 'keyed' && (registration.key === undefined || registration.key === '')) {
      throw new Error(`slot "${name}" is keyed; register() requires a non-empty key`)
    }
    if (state.kind === 'list' && registration.key !== undefined) {
      throw new Error(`slot "${name}" is a list; register() must not pass a key`)
    }

    const entry: SlotEntry = {
      id:
        registration.id ??
        `${component.displayName ?? component.name ?? 'anonymous'}#${state.sequence++}`,
      component,
      // single 的 key / order 没有意义：忽略，保持旧签名可用。
      key: state.kind === 'keyed' ? registration.key : undefined,
      order: registration.order ?? 0
    }

    if (state.kind === 'keyed') {
      const index = state.entries.findIndex((item) => item.key === entry.key)
      if (index >= 0) state.entries[index] = entry
      else state.entries.push(entry)
    } else {
      state.entries.push(entry)
      if (state.kind === 'list') state.entries.sort(byOrder)
    }

    this.commit(state)

    return () => this.remove(name, entry)
  }

  /** single：第一个注册者（与旧行为一致）。 */
  get(name: string): SlotComponent | undefined {
    return this.slots.get(name)?.entries[0]?.component
  }

  /** keyed：按 key 取；没有匹配返回 undefined。 */
  getKeyed(name: string, key: string): SlotComponent | undefined {
    return this.slots.get(name)?.entries.find((entry) => entry.key === key)?.component
  }

  /** 当前全部 occupant；list 可按它渲染。 */
  list(name: string): readonly SlotEntry[] {
    return this.snapshot(name)
  }

  /** 同 list：保留一个语义更中性的名字给渲染侧。 */
  entries(name: string): readonly SlotEntry[] {
    return this.snapshot(name)
  }

  /**
   * 当前快照。同一个版本内返回**同一个引用**，供 `useSyncExternalStore` 使用；
   * 注册 / 注销 / 覆盖 key 才换引用。
   */
  snapshot(name: string): readonly SlotEntry[] {
    return this.state(name).snapshot
  }

  /** 已声明的种类；未声明返回 single。 */
  kindOf(name: string): SlotKind {
    return this.slots.get(name)?.kind ?? 'single'
  }

  /** 订阅某个槽的变化；返回取消订阅。 */
  subscribe(name: string, listener: () => void): () => void {
    const state = this.state(name)
    state.listeners.add(listener)

    return () => {
      state.listeners.delete(listener)
    }
  }

  /** 调试用：某个 slot 里注册了多少个 occupant。 */
  count(name: string): number {
    return this.slots.get(name)?.entries.length ?? 0
  }

  private state(name: string): SlotState {
    let state = this.slots.get(name)
    if (!state) {
      state = {
        kind: 'single',
        declared: false,
        entries: [],
        snapshot: NO_ENTRIES,
        listeners: new Set(),
        sequence: 0
      }
      this.slots.set(name, state)
    }
    return state
  }

  private remove(name: string, entry: SlotEntry): void {
    const state = this.slots.get(name)
    if (!state) return
    const index = state.entries.indexOf(entry)
    if (index < 0) return

    state.entries.splice(index, 1)
    this.commit(state)
  }

  private commit(state: SlotState): void {
    state.snapshot = Object.freeze([...state.entries])
    for (const listener of state.listeners) {
      try {
        listener()
      } catch (error) {
        // 一个监听者失败不该让其他监听者（以及注册本身）失败。
        console.error('[slots] listener failed', error)
      }
    }
  }
}

/**
 * 按槽种类挑出要渲染的 entry。
 *
 * 纯函数，方便单测；`Slot` 组件只负责订阅与 `createElement`。
 */
export function resolveSlot(
  kind: SlotKind,
  entries: readonly SlotEntry[],
  activeKey?: string
): readonly SlotEntry[] {
  if (kind === 'single') return entries.length === 0 ? NO_ENTRIES : [entries[0]]

  if (kind === 'keyed') {
    if (activeKey === undefined) return NO_ENTRIES
    return entries.filter((entry) => entry.key === activeKey)
  }

  return entries
}

/** list / 声明升级时使用：order 升序；同 order 依赖 Array.sort 的稳定性保留注册顺序。 */
function byOrder(a: SlotEntry, b: SlotEntry): number {
  return a.order - b.order
}

/**
 * 从 Cordis 上下文取 slots 服务。
 *
 * 刻意**不做模块增强**（`declare module`）：Cordis 的 `Context` 是从
 * `./context.ts` re-export 出来的，在包入口上增强 `Context` 会遮蔽原接口，
 * 导致 `plugin` / `effect` 等混入成员全部丢失。这里用显式取服务代替。
 */
export function slotsOf(ctx: Context): SlotRegistry {
  const slots = ctx.get('slots')
  if (!(slots instanceof SlotRegistry)) {
    throw new Error('slots service is not provided on this context')
  }
  return slots
}
