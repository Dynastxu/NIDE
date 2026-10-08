import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'

/**
 * 仓库里**本地化数据**的一致性校验。
 *
 * 这不是在测代码，而是在测数据：宿主基础词条表、各语言包、各插件的 manifest
 * 词条，三者之间的 key 集合必须严丝合缝。少一条就会在运行时静默回落成中文
 * （界面上表现为中英混排），多一条则是拼错或宿主已删 —— 两种都只有构建期
 * 才拦得住，人眼是发现不了的。
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE_TABLE = path.join(ROOT, 'src', 'shared', 'i18n', 'locales', 'zh-CN.ts')
const PLUGIN_DIRS = [
  path.join(ROOT, 'plugins', 'builtin'),
  // 第三方语言包通常不在仓库里，但本地调试时可能放这儿
  path.join(ROOT, 'plugins', 'third-party')
]

/**
 * 从 zh-CN.ts 取出 `host.*` key 集合。
 *
 * 用 TypeScript 编译器 API 解析而不是正则：`host.locale.switch.message` 那种
 * 跨行字符串拼接正则处理不了，而且解析失败时正则方案会静默通过。
 */
function readBaseKeys(): Set<string> {
  const source = ts.createSourceFile(
    BASE_TABLE,
    fs.readFileSync(BASE_TABLE, 'utf-8'),
    ts.ScriptTarget.Latest,
    true
  )

  let found: ts.ObjectLiteralExpression | null = null
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'zhCN' &&
      node.initializer
    ) {
      // `{...} as const` -> 初始值被包在 AsExpression 里
      const init = ts.isAsExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer
      if (ts.isObjectLiteralExpression(init)) found = init
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  if (!found) {
    throw new Error(`没能从 ${path.relative(ROOT, BASE_TABLE)} 里解析出 zhCN 对象字面量`)
  }

  const keys = new Set<string>()
  for (const property of (found as ts.ObjectLiteralExpression).properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)) {
      keys.add(property.name.text)
    }
  }
  return keys
}

/** 递归找出插件 manifest（跳过 node_modules / .git / out，避免误扫） */
function findPluginManifests(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'out') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) findPluginManifests(full, out)
    else if (entry.name === 'manifest.json') out.push(full)
  }
  return out.filter((p) => PLUGIN_DIRS.some((root) => p.startsWith(root)))
}

/** 递归收集 manifest 里所有 `%key%`（整串被 % 包住才算，所以 "100% done" 不会被误判） */
function collectPlaceholders(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    const match = /^%(.+)%$/.exec(value)
    if (match) out.add(match[1])
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPlaceholders(item, out)
    return out
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectPlaceholders(item, out)
  }
  return out
}

interface LocalePackCase {
  locale: string
  file: string
  error?: string
  missing: string[]
  extra: string[]
}

interface ManifestNlsCase {
  file: string
  error?: string
  missing: string[]
  unused: string[]
}

const NLS_FILE_RE = /^package\.nls\.(.+)\.json$/

function collectCases(baseKeys: Set<string>): {
  packs: LocalePackCase[]
  nls: ManifestNlsCase[]
} {
  const packs: LocalePackCase[] = []
  const nls: ManifestNlsCase[] = []

  for (const manifestPath of findPluginManifests(ROOT)) {
    const pluginDir = path.dirname(manifestPath)
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    } catch (err) {
      packs.push({
        locale: '(manifest 解析失败)',
        file: path.relative(ROOT, manifestPath),
        error: String(err),
        missing: [],
        extra: []
      })
      continue
    }

    const contributes = (manifest.contributes ?? {}) as Record<string, unknown>

    // ---- 语言包：翻的是宿主自己的文案，key 必须和基础表完全一致 ----
    for (const raw of (contributes.locales ?? []) as Record<string, unknown>[]) {
      const locale = typeof raw.locale === 'string' ? raw.locale : '(缺 locale)'
      const rel = typeof raw.file === 'string' ? raw.file : ''
      const abs = rel ? path.resolve(pluginDir, rel) : ''

      if (!rel || !abs || !fs.existsSync(abs)) {
        packs.push({
          locale,
          file: rel || '(缺 file)',
          error: '声明的词条文件不存在',
          missing: [],
          extra: []
        })
        continue
      }

      try {
        const table = JSON.parse(fs.readFileSync(abs, 'utf-8')) as Record<string, string>
        const keys = new Set(Object.keys(table))
        packs.push({
          locale,
          file: path.relative(ROOT, abs),
          missing: [...baseKeys].filter((k) => !keys.has(k)),
          extra: [...keys].filter((k) => !baseKeys.has(k))
        })
      } catch (err) {
        packs.push({
          locale,
          file: path.relative(ROOT, abs),
          error: String(err),
          missing: [],
          extra: []
        })
      }
    }

    // ---- manifest 词条：翻的是插件自己的 manifest 文案 ----
    const used = collectPlaceholders(manifest)
    if (used.size === 0) continue

    const nlsFiles = fs
      .readdirSync(pluginDir)
      .filter((name) => name === 'package.nls.json' || NLS_FILE_RE.test(name))

    if (nlsFiles.length === 0) {
      nls.push({
        file: path.relative(ROOT, manifestPath),
        error: `manifest 用了 ${used.size} 个 %key%，但插件目录下没有任何 package.nls*.json`,
        missing: [],
        unused: []
      })
      continue
    }

    for (const name of nlsFiles) {
      const full = path.join(pluginDir, name)
      try {
        const table = JSON.parse(fs.readFileSync(full, 'utf-8')) as Record<string, string>
        const keys = new Set(Object.keys(table))
        nls.push({
          file: path.relative(ROOT, full),
          missing: [...used].filter((k) => !keys.has(k)),
          unused: [...keys].filter((k) => !used.has(k))
        })
      } catch (err) {
        nls.push({ file: path.relative(ROOT, full), error: String(err), missing: [], unused: [] })
      }
    }
  }

  return { packs, nls }
}

const baseKeys = readBaseKeys()
const manifests = findPluginManifests(ROOT)
const { packs, nls } = collectCases(baseKeys)

describe('本地化数据确实被扫到了', () => {
  // 没有这两条守卫，下面所有 describe.each 在「一个用例都没生成」时会整体假绿
  it('解析出了宿主基础词条表', () => {
    expect(baseKeys.size).toBeGreaterThan(0)
  })

  it('扫到了插件 manifest', () => {
    expect(manifests.length).toBeGreaterThan(0)
  })

  it('至少有一个语言包和一个 manifest 词条文件被检查', () => {
    expect(packs.length).toBeGreaterThan(0)
    expect(nls.length).toBeGreaterThan(0)
  })
})

describe.each(packs)('语言包 $locale — $file', (fixture) => {
  it('能正常读取', () => {
    expect(fixture.error).toBeUndefined()
  })

  it('没有漏翻的 key（漏了会在运行时回落成中文）', () => {
    expect(fixture.missing).toEqual([])
  })

  it('没有宿主不认识的 key（拼错，或宿主已删除）', () => {
    expect(fixture.extra).toEqual([])
  })
})

describe.each(nls)('manifest 词条 $file', (fixture) => {
  it('能正常读取', () => {
    expect(fixture.error).toBeUndefined()
  })

  it('覆盖 manifest 用到的每个 %key%（少了界面会显示原样占位符）', () => {
    expect(fixture.missing).toEqual([])
  })

  it('没有未被 manifest 引用的 key', () => {
    expect(fixture.unused).toEqual([])
  })
})
