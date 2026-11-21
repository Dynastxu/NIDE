/**
 * 由 `scripts/gen-client-roster.mts` 生成，不要手改。
 *
 * 元数据在各自的 package.json（`nide.client.windowTypes` / `order`），
 * 生成物只把「哪个包挂到哪个窗口」变成静态 import，交给 Vite 分割。
 */
import type { ClientWindowType } from './window-type'

export interface ClientRosterEntry {
  /** 包名（排障与测试用） */
  package: string
  windowTypes: readonly ClientWindowType[]
  load: () => Promise<{ clientPlugins: readonly unknown[] }>
}

export const CLIENT_ROSTER: readonly ClientRosterEntry[] = [
  {
    package: "@nide/client-ui-main",
    windowTypes: ["main"],
    load: () => import("@nide/client-ui-main")
  },
  {
    package: "@nide/client-ui-explorer",
    windowTypes: ["main"],
    load: () => import("@nide/client-ui-explorer")
  },
  {
    package: "@nide/client-ui-git",
    windowTypes: ["main"],
    load: () => import("@nide/client-ui-git")
  },
  {
    package: "@nide/client-ui-welcome",
    windowTypes: ["welcome"],
    load: () => import("@nide/client-ui-welcome")
  },
  {
    package: "@nide/client-ui-settings",
    windowTypes: ["settings"],
    load: () => import("@nide/client-ui-settings")
  }
]
