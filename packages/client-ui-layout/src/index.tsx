import { createElement, type JSX } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { slotsOf } from '@nide/client-ui-slots'
import { ToolZone } from '@renderer/layout/ToolZone'
import type { ZoneId } from '@renderer/stores/layout.store'

/**
 * 六个工具区的 slot 插件（MVP）。
 *
 * 每个 occupant 只是把现有 `ToolZone` 包一层；`WorkbenchLayout` 里对应位置改成
 * `<Slot name="zone.*" fallback={<ToolZone .../>}>`。所以：
 * - 有 slot 注册时，走注册表；
 * - 客户端树没起来时，走 fallback，布局照旧。
 *
 * 下一步才是把「哪个视图占据这个区」交给 slot 内容，而不是让 ToolZone 自己读 store。
 */

const ZONES: readonly ZoneId[] = [
  'leftTop',
  'leftBottom',
  'rightTop',
  'rightBottom',
  'bottomLeft',
  'bottomRight'
]

function zoneComponent(id: ZoneId): () => JSX.Element {
  return () => createElement(ToolZone, { id })
}

export const layoutPlugin = {
  name: 'nide-client-ui-layout',
  inject: ['slots'],
  apply(ctx: Context): void {
    const slots = slotsOf(ctx)
    for (const id of ZONES) {
      ctx.effect(() => slots.register(`zone.${id}`, zoneComponent(id)), `zone.${id}`)
    }
    ctx.logger('client-ui-layout').info('zone slots registered', { count: ZONES.length })
  }
}
