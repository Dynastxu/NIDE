import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CLIENT_ROSTER } from '../../packages/client-runtime/src/roster.generated'

/**
 * 客户端花名册的一致性。
 *
 * 生成物（`roster.generated.ts`）是**提交进仓库**的：它带静态 `import()`，Vite 才能
 * 做代码分割。代价是「改了 package.json 忘了重新生成」不会被构建发现 —— 这条用例
 * 就是那个检查点。
 */
function clientPackages(): { dir: string; name: string; windowTypes: string[]; order: number }[] {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages')
  const packages: { dir: string; name: string; windowTypes: string[]; order: number }[] = []

  for (const dir of fs.readdirSync(root)) {
    if (!dir.startsWith('client-ui-')) continue
    const manifestPath = path.join(root, dir, 'package.json')
    if (!fs.existsSync(manifestPath)) continue

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      name?: string
      nide?: { client?: { windowTypes?: unknown; order?: unknown } }
    }
    const client = manifest.nide?.client
    if (!client) continue

    const windowTypes = Array.isArray(client.windowTypes)
      ? client.windowTypes.filter((value): value is string => typeof value === 'string')
      : []
    if (windowTypes.length === 0) continue

    packages.push({
      dir,
      name: manifest.name ?? dir,
      windowTypes,
      order: typeof client.order === 'number' ? client.order : 0
    })
  }

  return packages
}

describe('客户端花名册', () => {
  it('roster.generated.ts 与各包 package.json 的 nide.client 一致', () => {
    const expected = clientPackages()
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map((entry) => ({ package: entry.name, windowTypes: entry.windowTypes }))

    expect(
      CLIENT_ROSTER.map((entry) => ({
        package: entry.package,
        windowTypes: [...entry.windowTypes]
      }))
    ).toEqual(expected)
  })

  it('每个条目都有加载函数，窗口种类非空', () => {
    for (const entry of CLIENT_ROSTER) {
      expect(typeof entry.load).toBe('function')
      expect(entry.windowTypes.length).toBeGreaterThan(0)
    }
  })
})
