import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ZoneId =
  'leftTop' | 'leftBottom' | 'rightTop' | 'rightBottom' | 'bottomLeft' | 'bottomRight'

export const ZONE_IDS = [
  'leftTop',
  'leftBottom',
  'rightTop',
  'rightBottom',
  'bottomLeft',
  'bottomRight'
] as const satisfies readonly ZoneId[]

const ZONE_ID_SET: ReadonlySet<string> = new Set(ZONE_IDS)

/** 判断一个 ViewLocation 是不是 6 个可显隐工具区之一（'main' 不是） */
export function isZoneId(location: string): location is ZoneId {
  return ZONE_ID_SET.has(location)
}

/** 全部尺寸统一用 px，拖动时只做加减，避免百分比换算 */
export type SizeKey =
  | 'leftWidth'
  | 'rightWidth'
  | 'bottomHeight'
  | 'leftTopHeight'
  | 'rightTopHeight'
  | 'bottomLeftWidth'

interface ZoneState {
  visible: boolean
  /**
   * 该区当前展示的视图 id。
   *
   * null 表示「跟随该区的第一个视图」—— 视图列表是异步加载的，初始状态
   * 不可能知道任何 id，用一个显式的 null 比用 undefined 表达「还没选过」更清楚。
   */
  activeViewId: string | null
}

const LIMITS: Record<SizeKey, [number, number]> = {
  leftWidth: [180, 640],
  rightWidth: [180, 640],
  bottomHeight: [80, 600],
  leftTopHeight: [80, 800],
  rightTopHeight: [80, 800],
  bottomLeftWidth: [160, 900]
}

const clamp = (v: number, [min, max]: [number, number]): number => Math.min(max, Math.max(min, v))

export const SIZE_DEFAULTS = {
  leftWidth: 260,
  rightWidth: 320,
  bottomHeight: 200,
  leftTopHeight: 260,
  rightTopHeight: 260,
  bottomLeftWidth: 320
} satisfies Record<SizeKey, number>

/** 默认每侧各开上面一块，避免一进来就满屏 */
const initialZones = (): Record<ZoneId, ZoneState> => ({
  leftTop: { visible: true, activeViewId: null },
  leftBottom: { visible: false, activeViewId: null },
  rightTop: { visible: true, activeViewId: null },
  rightBottom: { visible: false, activeViewId: null },
  bottomLeft: { visible: true, activeViewId: null },
  bottomRight: { visible: false, activeViewId: null }
})

interface LayoutState extends Record<SizeKey, number> {
  zones: Record<ZoneId, ZoneState>
  /** 侧边按钮条是否在图标下面显示视图标题（右键按钮条切换） */
  showStripeTitles: boolean
  setShowStripeTitles: (show: boolean) => void
  setVisible: (id: ZoneId, visible: boolean) => void
  /** 显示某个视图：打开它所在的区，并把该区切到它 */
  showView: (id: ZoneId, viewId: string) => void
  grow: (key: SizeKey, delta: number) => void
  setSize: (key: SizeKey, px: number) => void
  /** 双击分隔条时把某一个尺寸恢复默认 */
  resetSize: (key: SizeKey) => void
  reset: () => void
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set) => ({
      ...SIZE_DEFAULTS,
      zones: initialZones(),
      showStripeTitles: true,

      setShowStripeTitles: (show) => set({ showStripeTitles: show }),

      setVisible: (id, visible) =>
        set((s) => ({ zones: { ...s.zones, [id]: { ...s.zones[id], visible } } })),

      showView: (id, viewId) =>
        set((s) => ({ zones: { ...s.zones, [id]: { visible: true, activeViewId: viewId } } })),

      grow: (key, delta) =>
        set((s) => ({ [key]: clamp(s[key] + delta, LIMITS[key]) }) as Partial<LayoutState>),

      setSize: (key, px) => set({ [key]: clamp(px, LIMITS[key]) } as Partial<LayoutState>),

      resetSize: (key) => set({ [key]: SIZE_DEFAULTS[key] } as Partial<LayoutState>),

      reset: () => set({ ...SIZE_DEFAULTS, zones: initialZones(), showStripeTitles: true })
    }),
    {
      name: 'nide.layout', // localStorage，重启窗口后布局保持
      /**
       * v1 只存了 zones[id].visible，没有 activeViewId。
       * 语义已经从「按区开关」变成「按视图开关」，旧状态直接丢弃、回到默认布局
       * （布局偏好重建成本很低，不值得为它写迁移代码）。
       */
      version: 2
    }
  )
)
