/**
 * 生成客户端 roster（`packages/client-runtime/src/roster.generated.ts`）。
 *
 * 装配点从运行时代码挪到**包元数据**：每个客户端包在 package.json 里声明
 *
 *   "nide": { "client": { "windowTypes": ["main"], "order": 20 } }
 *
 * 并导出 `clientPlugins`。窗口包注册 `<window>.root`；功能包只注册自己负责的
 * slot（例如 `client-ui-git` 注册两个内建视图）。加一个客户端包 = 新增一个包 +
 * 跑一次本脚本，运行时不认识任何具体窗口或功能。
 *
 * 生成物要**提交**：它带静态 `import()`，Vite 才能做代码分割；运行时读
 * package.json 会绕开打包器的静态分析。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

interface ClientPackage {
  package: string
  windowTypes: string[]
  order: number
}

const root = process.cwd()
const packagesRoot = path.join(root, 'packages')
const output = path.join(packagesRoot, 'client-runtime', 'src', 'roster.generated.ts')

/** 一个界面包的元数据 */
function readClientPackages(): ClientPackage[] {
  const entries: ClientPackage[] = []
  for (const name of fs.readdirSync(packagesRoot)) {
    if (!name.startsWith('client-ui-')) continue

    const manifestPath = path.join(packagesRoot, name, 'package.json')
    if (!fs.existsSync(manifestPath)) continue

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      name?: string
      nide?: { client?: { windowTypes?: unknown; order?: unknown } }
    }
    const client = manifest.nide?.client
    if (!client) continue

    const windowTypes = Array.isArray(client.windowTypes)
      ? client.windowTypes.filter((value): value is string => typeof value === 'string')
      : []
    if (windowTypes.length === 0) continue

    entries.push({
      package: manifest.name ?? name,
      windowTypes,
      order: typeof client.order === 'number' ? client.order : 0
    })
  }

  return entries.sort((a, b) => a.order - b.order || a.package.localeCompare(b.package))
}

const entries = readClientPackages()

const file = `/**
 * 由 \`scripts/gen-client-roster.mts\` 生成，不要手改。
 *
 * 元数据在各自的 package.json（\`nide.client.windowTypes\` / \`order\`），
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
${entries
  .map(
    (entry) => `  {
    package: ${JSON.stringify(entry.package)},
    windowTypes: ${JSON.stringify(entry.windowTypes)},
    load: () => import(${JSON.stringify(entry.package)})
  }`
  )
  .join(',\n')}
]
`

fs.writeFileSync(output, file)
console.log(`[client-roster] wrote ${path.relative(root, output)} (${entries.length} entries)`)
