import fs from 'node:fs'
import path from 'node:path'

/**
 * 每插件命名空间的键值存储（宿主侧）。
 *
 * 布局：`<userData>/plugin-storage/<encodeURIComponent(pluginId)>.json`
 *
 * 插件后端拿到的是**同步**视图（见 `backend/worker.ts` 的 RemoteStorage）：
 * `set` 立刻可见，落盘走 100ms 合并窗口；插件停用 / 卸载 / 宿主退出前
 * 必须 `flush`（`flushAll`），否则最后几次写入会丢。
 *
 * 与 mics 的 `ctx.storage` 一致：一个插件一个命名空间，互相看不见。
 */

export const PLUGIN_STORAGE_DIR = 'plugin-storage'
export const STORAGE_FLUSH_MS = 100

export function pluginStorageFile(userDataDir: string, pluginId: string): string {
  return path.join(userDataDir, PLUGIN_STORAGE_DIR, `${encodeURIComponent(pluginId)}.json`)
}

interface Entry {
  data: Record<string, unknown>
  loaded: boolean
  timer: ReturnType<typeof setTimeout> | null
  dirty: boolean
}

export class PluginStorage {
  private readonly userDataDir: string
  private readonly entries = new Map<string, Entry>()

  constructor(options: { userDataDir: string }) {
    this.userDataDir = options.userDataDir
  }

  /** 读整份快照；启动 worker 时把它塞进 bootstrap */
  snapshot(pluginId: string): Record<string, unknown> {
    return { ...this.entry(pluginId).data }
  }

  get(pluginId: string, key: string): unknown {
    return this.entry(pluginId).data[key]
  }

  set(pluginId: string, key: string, value: unknown): void {
    const entry = this.entry(pluginId)
    entry.data[key] = value
    entry.dirty = true
    this.schedule(pluginId, entry)
  }

  delete(pluginId: string, key: string): void {
    const entry = this.entry(pluginId)
    if (!(key in entry.data)) return
    delete entry.data[key]
    entry.dirty = true
    this.schedule(pluginId, entry)
  }

  /** 立即落盘（插件停用 / 卸载 / 宿主退出前调） */
  flush(pluginId: string): void {
    const entry = this.entries.get(pluginId)
    if (!entry || !entry.dirty) return

    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }

    const file = pluginStorageFile(this.userDataDir, pluginId)
    const tmp = `${file}.tmp`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(tmp, `${JSON.stringify(entry.data, null, 2)}\n`, 'utf-8')
      fs.renameSync(tmp, file)
      entry.dirty = false
    } catch (error) {
      console.warn('[nide-host] failed to persist the plugin storage', { pluginId, error })
    }
  }

  flushAll(): void {
    for (const pluginId of this.entries.keys()) this.flush(pluginId)
  }

  /** 卸载时调用：取消挂起的写入并删掉文件 */
  remove(pluginId: string): void {
    const entry = this.entries.get(pluginId)
    if (entry?.timer) clearTimeout(entry.timer)
    this.entries.delete(pluginId)

    try {
      fs.rmSync(pluginStorageFile(this.userDataDir, pluginId), { force: true })
    } catch (error) {
      // 删不掉只是留一份不会再被读取的 JSON，不该让卸载失败
      console.warn('[nide-host] failed to remove the plugin storage file', { pluginId, error })
    }
  }

  private entry(pluginId: string): Entry {
    let entry = this.entries.get(pluginId)
    if (entry) return entry

    entry = { data: {}, loaded: false, timer: null, dirty: false }
    try {
      const raw = JSON.parse(
        fs.readFileSync(pluginStorageFile(this.userDataDir, pluginId), 'utf-8')
      ) as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        entry.data = raw as Record<string, unknown>
      }
    } catch {
      // 首次启动（文件不存在）与文件损坏同一条：空存储不是错误
    }
    entry.loaded = true
    this.entries.set(pluginId, entry)
    return entry
  }

  private schedule(pluginId: string, entry: Entry): void {
    if (entry.timer) return
    entry.timer = setTimeout(() => {
      entry.timer = null
      this.flush(pluginId)
    }, STORAGE_FLUSH_MS)
    entry.timer.unref?.()
  }
}
