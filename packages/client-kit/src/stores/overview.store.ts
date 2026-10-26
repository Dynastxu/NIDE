import { create } from 'zustand'
import { loggerFor } from '@nide/client-kit/logger'
import type { DirReadFailureReason, OverviewDocument } from '@shared/project'

const logger = loggerFor('overview')

/**
 * 概述的状态：当前项目的概述目录里有哪些 Markdown。
 *
 * 只存**文件列表**，不存「哪份是大纲 / 写作风格」：后者来自项目配置
 * （`config.overview.outline / style`），而归 explorer store 持有 —— 配置是唯一的真相，
 * 这里再存一份就会出现「改了映射、列表还按旧的认」这种两套说法。
 *
 * 与 gallery.store 同一种形状与同一条生命周期：数据来自主进程一次读盘，换项目时整份
 * 丢掉；新建 / 删除文档之后强制重读。
 */
interface OverviewState {
  /** 概述内容目录的绝对路径。新建文档时要用它当落点 */
  root: string | null
  /** 概述目录里的 Markdown。null 表示**还没读过**（空数组表示确实一个都没有） */
  documents: OverviewDocument[] | null
  loading: boolean
  /** 读概述列表的失败原因；null 表示这次读没出错 */
  error: DirReadFailureReason | null

  /** 读一次概述列表。已经读过同一个目录、且不是强制刷新时直接返回 */
  load: (overviewRoot: string, force?: boolean) => Promise<void>
  /** 换项目 / 关掉项目时把这一份丢掉 */
  forget: () => void
}

export const useOverviewStore = create<OverviewState>((set, get) => ({
  root: null,
  documents: null,
  loading: false,
  error: null,

  load: async (overviewRoot, force = false) => {
    // 正在读就不接第二次：面板的一次挂载可能触发多条刷新
    if (get().loading) return
    if (!force && get().documents !== null && get().root === overviewRoot) return

    set({ root: overviewRoot, loading: true, error: null })

    try {
      const result = await window.hostAPI.projects.readOverview(overviewRoot)
      if (!result.ok) {
        logger.warn('Failed to read the overview list', { reason: result.reason })
        // documents 保持原样（可能还是 null）：错误由 error 表达，界面据此说「读不了」
        // 而不是「一个文档都没有」
        set({ error: result.reason })
        return
      }

      set({ documents: result.documents })
    } catch (err) {
      logger.error('Reading the overview list failed unexpectedly', { error: err })
      set({ error: 'unreadable' })
    } finally {
      set({ loading: false })
    }
  },

  forget: () => set({ root: null, documents: null, loading: false, error: null })
}))
