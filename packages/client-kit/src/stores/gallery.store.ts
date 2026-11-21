import { create } from 'zustand'
import { isInsideProject } from '@nide/domain/project'
import { loggerFor } from '@nide/client-kit/logger'
import type { DirReadFailureReason, GalleryFolder, GalleryRegistry } from '@nide/domain/project'

const logger = loggerFor('gallery')

/**
 * 图鉴的状态：当前项目有哪些图鉴、各自的字段与条目，以及「哪个图鉴是角色图鉴」。
 *
 * ## 为什么单独一个 store
 *
 * 图鉴的消费者**不在一个面板里**：左侧「项目」标签页要列出图鉴与条目，章节表单的
 * 出场角色要从角色图鉴里选，图鉴条目的表单要知道自己那个图鉴有哪些字段。它们分布在
 * 三棵互不相邻的子树上，读的却是同一份数据 —— 放在某一个面板里就等于让另外两处
 * 各自再读一次盘。所以它住在 client-kit：explorer 与 editor 都依赖平台库，而不是
 * 互相 import store。
 *
 * ## 路径从哪来
 *
 * 图鉴内容目录的绝对路径来自项目配置（相对项目根算出来），那一份属于 explorer store。
 * 这里**收一个路径**（`load` 的第一个参数）而不是自己去读配置：依赖只有一个方向
 * （explorer -> gallery）。explorer 在模块加载时用 `setGalleryLoader` 注册
 * 「项目根 + 配置 -> 图鉴目录」；编辑器表单只调 `ensureGalleries()`，不 import
 * explorer store。
 *
 * ## 生命周期
 *
 * 与文件树、章节列表同一条：换项目时整份丢掉（explorer.store 的 setRoots 会调
 * `forget`）。图鉴列表是一次性的读盘结论，而换项目会重建窗口 —— 这一份没有理由
 * 活过那一次重建。
 */
interface GalleryState {
  /** 图鉴内容目录的绝对路径。创建图鉴时要用它当落点（见 renderer 的 gallery-actions） */
  root: string | null
  /** 项目里的图鉴。null 表示**还没读过**（空数组表示确实一个都没有） */
  galleries: GalleryFolder[] | null
  /** `.nide/config.yml` 里图鉴那一段的 `characters`：哪个图鉴是角色图鉴。null 表示还没读过 */
  registry: GalleryRegistry | null
  loading: boolean
  /** 读图鉴列表的失败原因；null 表示这次读没出错 */
  error: DirReadFailureReason | null

  /**
   * 读一次图鉴列表。
   *
   * 已经读过同一个目录、且不是强制刷新时直接返回：这一份在一次会话里不会自己变，
   * 而三个消费者会各自在挂载时来问一次（见文件头）。
   */
  load: (galleryRoot: string, force?: boolean) => Promise<void>
  /**
   * 就地换掉注册表。
   *
   * 「设为角色图鉴」刚刚成功时用它：那一条改动只碰注册表，重读整份列表（含每个图鉴
   * 的每个条目）只为了一行结果不合适。注册表本身来自主进程的返回值，不是这里猜的。
   */
  setRegistry: (registry: GalleryRegistry) => void
  /** 换项目 / 关掉项目时把这一份丢掉 */
  forget: () => void
}

export const useGalleryStore = create<GalleryState>((set, get) => ({
  root: null,
  galleries: null,
  registry: null,
  loading: false,
  error: null,

  load: async (galleryRoot, force = false) => {
    // 正在读就不接第二次：面板、表单、角色选择器会在同一次渲染里各问一次
    if (get().loading) return
    if (!force && get().galleries !== null && get().root === galleryRoot) return

    set({ root: galleryRoot, loading: true, error: null })

    try {
      const result = await window.hostAPI.projects.readGalleries(galleryRoot)
      if (!result.ok) {
        logger.warn('Failed to read the gallery list', { reason: result.reason })
        // galleries 保持原样（可能还是 null）：错误由 error 表达，界面据此说「读不了」
        // 而不是「一个图鉴都没有」
        set({ error: result.reason })
        return
      }

      set({ galleries: result.galleries, registry: result.registry })
    } catch (err) {
      logger.error('Reading the gallery list failed unexpectedly', { error: err })
      set({ error: 'unreadable' })
    } finally {
      set({ loading: false })
    }
  },

  setRegistry: (registry) => set({ registry }),

  forget: () => set({ root: null, galleries: null, registry: null, loading: false, error: null })
}))

/**
 * 一个文件所在的那个图鉴。
 *
 * 判据是「这个路径在不在那个图鉴目录里」（逐段比对、大小写折叠，与文件树算祖先链时
 * 同一套），不是「父目录字符串相等」：图鉴目录里再放子目录时不至于认不出来，而
 * `卷一` 与 `卷一2` 这种前缀相同的兄弟不会被误判。
 *
 * 找不到时给 null：文件不在图鉴目录里、列表还没读出来、或者那个图鉴读不出来。调用方
 * 据此只按文件自己的键行事（见 GalleryEntryForm）。
 */
export function galleryOfPath(
  galleries: readonly GalleryFolder[] | null,
  path: string
): GalleryFolder | null {
  if (!galleries || path.length === 0) return null

  return galleries.find((gallery) => isInsideProject(gallery.path, path, true)) ?? null
}

/**
 * 角色图鉴：注册表指的那一个，在图鉴列表里按目录名找。
 *
 * 找不到时给 null（列表还没读、图鉴被改名、图鉴被删掉……）：调用方据此**什么建议都
 * 不给**，而不是拿一个猜出来的图鉴去凑。大小写折叠着比 —— 用户的目录名与注册表里
 * 那个写法不一致时（在大小写不敏感的平台上它们是同一个目录）不该判成找不到。
 */
export function characterGalleryOf(
  galleries: readonly GalleryFolder[] | null,
  registry: GalleryRegistry | null
): GalleryFolder | null {
  if (!galleries || !registry) return null

  const wanted = registry.characters.trim().toLowerCase()
  if (wanted.length === 0) return null

  return galleries.find((gallery) => gallery.name.toLowerCase() === wanted) ?? null
}

type GalleryLoader = (force?: boolean) => Promise<void>

let loader: GalleryLoader | null = null

/**
 * 由 explorer 注册「怎么把项目根 + 配置翻译成图鉴目录」。
 *
 * 编辑器表单只调 `ensureGalleries()`，不知道项目根 / 配置在哪，也不 import
 * explorer store —— 这是两边都依赖 kit、而不是互相依赖的那条边。
 */
export function setGalleryLoader(next: GalleryLoader | null): void {
  loader = next
}

/** 确保图鉴列表已读（幂等：store 自己会判重）；没有注册 loader 时什么都不做。 */
export async function ensureGalleries(force = false): Promise<void> {
  await loader?.(force)
}
