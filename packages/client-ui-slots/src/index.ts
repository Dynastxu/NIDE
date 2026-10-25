import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'

/**
 * 具名插槽注册表（纯逻辑，不依赖 React 运行时）。
 *
 * 现在只支持 single（第一个注册者生效）；list / keyed 等语义等真正需要时再加。
 * slot 名沿用 DSH 的命名风格：`welcome.root`、`main.root`、`settings.root`，
 * 以后扩展 `zone.leftTop`、`settings.nav` 之类。
 *
 * 注意：这个文件只有 `import type`，所以 host / 非 React 环境 import 它也不会
 * 把 React 拖进 bundle。
 */

export type SlotComponent = ComponentType<Record<string, never>>

export class SlotRegistry {
  private readonly slots = new Map<string, SlotComponent[]>()

  /** 注册一个 slot occupant；返回注销函数（可直接交给 ctx.effect）。 */
  register(name: string, component: SlotComponent): () => void {
    const list = this.slots.get(name) ?? []
    list.push(component)
    this.slots.set(name, list)

    return () => {
      const current = this.slots.get(name)
      if (!current) return
      const next = current.filter((item) => item !== component)
      if (next.length === 0) this.slots.delete(name)
      else this.slots.set(name, next)
    }
  }

  /** single slot：第一个注册者生效。 */
  get(name: string): SlotComponent | undefined {
    return this.slots.get(name)?.[0]
  }

  /** 调试用：某个 slot 里注册了多少个 occupant。 */
  count(name: string): number {
    return this.slots.get(name)?.length ?? 0
  }
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
