/**
 * 生成包依赖图（`docs/architecture/package-graph.md`）。
 *
 * 三件事各有唯一来源：
 * - **层**：每个包的 `package.json` 里 `"nide": { "layer": ... }`；
 * - **边**：真实 import 的扫描结果（与 `check-imports` 共用 `scan()`，不维护第二套解析）；
 * - **允许的依赖**：`check-imports` 的 `ALLOWED` 表。
 *
 * 文档因此是**生成物**：`--check` 与仓库里的文件比对，不一致就退出 1 —— 这就是 CI
 * 的新鲜度门禁。加一个包、改一条依赖，图会变，忘了重新生成就会被拦住。
 *
 *   node scripts/gen-package-graph.mts            # 写文件
 *   node scripts/gen-package-graph.mts --check    # 只校验是否最新
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error —— Node 的相对 import 必须带扩展名；tsconfig.node 没开 allowImportingTsExtensions
import { ALLOWED, scan, type Layer } from './check-imports.mts'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const OUTPUT = path.join(ROOT, 'docs/architecture/package-graph.md')

/** 画图的层顺序：从根到叶子，和依赖方向一致 */
const LAYER_ORDER: readonly Layer[] = [
  'contract',
  'kernel',
  'service',
  'bootstrap',
  'shell',
  'client-platform',
  'client-sdk',
  'client-seam',
  'client-feature',
  'client-window',
  'client-runtime',
  'plugin',
  'bundle',
  'smoke',
  'app'
]

/** 依赖图里的节点名：去掉 packages/ 前缀，插件保留 plugins/ 段以区分同名目录 */
function shortName(key: string): string {
  return key.replace(/^packages\//, '')
}

/** mermaid 的节点 id 只认安全字符 */
function nodeId(key: string): string {
  return `pkg_${key.replace(/[^a-zA-Z0-9]+/g, '_')}`
}

interface EdgeSummary {
  from: string
  to: string
  kind: 'value' | 'type'
}

/**
 * 渲染整份文档。
 *
 * 纯函数：输入扫描结果，输出 Markdown —— `--check` 与写入走同一条路，不会有两份
 * 渲染逻辑对不上的可能。
 */
function render(
  layers: Map<string, Layer>,
  edges: readonly EdgeSummary[],
  counts: { imports: number }
): string {
  const byLayer = new Map<Layer, string[]>()
  for (const [key, layer] of layers) {
    if (key === 'apps/desktop/renderer') {
      // 引导壳不是 workspace 包，但图里要有它
      const list = byLayer.get(layer) ?? []
      list.push(key)
      byLayer.set(layer, list)
      continue
    }
    const list = byLayer.get(layer) ?? []
    list.push(key)
    byLayer.set(layer, list)
  }
  for (const list of byLayer.values()) list.sort()

  const lines: string[] = []
  lines.push('<!-- 由 scripts/gen-package-graph.mts 生成，不要手改。')
  lines.push('     跑 `pnpm gen:package-graph` 重新生成；CI 校验本文件是否最新。 -->')
  lines.push('')
  lines.push('# 包依赖图（生成物）')
  lines.push('')
  lines.push(
    '每个包属于哪一层由它的 `package.json` 声明（`"nide": { "layer": ... }`）；' +
      '边是**真实 import 扫描**的结果（与 `pnpm lint:imports` 同一份解析）。' +
      `共 ${layers.size} 个节点 / ${edges.length} 条包级依赖 / ${counts.imports} 条跨包 import。`
  )
  lines.push('')
  lines.push('实线 = 运行时 import；虚线 = 只有 `import type`（不产生运行时代码）。')
  lines.push('')
  lines.push('```mermaid')
  lines.push('flowchart TD')

  for (const layer of LAYER_ORDER) {
    const packages = byLayer.get(layer)
    if (!packages || packages.length === 0) continue
    lines.push(`  subgraph layer_${layer.replace(/[^a-zA-Z0-9]/g, '_')}["${layer}"]`)
    for (const key of packages) lines.push(`    ${nodeId(key)}["${shortName(key)}"]`)
    lines.push('  end')
  }

  for (const edge of [...edges].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  )) {
    const arrow = edge.kind === 'value' ? '-->' : '-.->'
    lines.push(`  ${nodeId(edge.from)} ${arrow} ${nodeId(edge.to)}`)
  }
  lines.push('```')
  lines.push('')
  lines.push('## 层与允许的依赖')
  lines.push('')
  lines.push('| 层 | 包 | 允许依赖 |')
  lines.push('| --- | --- | --- |')
  for (const layer of LAYER_ORDER) {
    const packages = byLayer.get(layer)
    if (!packages || packages.length === 0) continue
    const allowed = ALLOWED[layer]
    lines.push(
      `| \`${layer}\` | ${packages.map((key) => `\`${shortName(key)}\``).join(' ')} | ${
        allowed.length ? allowed.map((entry) => `\`${entry}\``).join(', ') : '（无）'
      } |`
    )
  }
  lines.push('')
  lines.push('## 怎么读这张图')
  lines.push('')
  lines.push(
    '- 一条边的方向是「谁 import 谁」，不是「谁启动谁」；Cordis 的启动顺序由 `inject` 决定。'
  )
  lines.push(
    '- 允许的依赖只限制**跨层**；同层内服务之间也只能 `import type`（见 `check-imports` 的说明）。'
  )
  lines.push('- 想加一条新边：先确认它落在「允许依赖」里，再改代码；图会跟着变，记得重新生成。')
  lines.push('')
  return lines.join('\n')
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check')
  const { edges, layers } = await scan()

  const unique = new Map<string, EdgeSummary>()
  for (const edge of edges) {
    const key = `${edge.from} -> ${edge.to}`
    const current = unique.get(key)
    // 只要有一条运行时 import，这条边就是实线
    if (!current || (current.kind === 'type' && edge.kind === 'value')) {
      unique.set(key, { from: edge.from, to: edge.to, kind: edge.kind })
    }
  }

  const text = render(layers, [...unique.values()], { imports: edges.length })

  if (check) {
    let existing = ''
    try {
      existing = await readFile(OUTPUT, 'utf8')
    } catch {
      console.error('[package-graph] 生成图不存在：跑 `pnpm gen:package-graph`')
      process.exitCode = 1
      return
    }
    // 行尾差异不算过期：Windows 检出是 CRLF，生成器产出 LF
    if (existing.replace(/\r\n/g, '\n').trimEnd() !== text.trimEnd()) {
      console.error('[package-graph] 生成图已过期：跑 `pnpm gen:package-graph` 并提交')
      process.exitCode = 1
      return
    }
    console.log('[package-graph] 生成图是最新的')
    return
  }

  await writeFile(OUTPUT, text, 'utf8')
  console.log(`[package-graph] wrote ${path.relative(ROOT, OUTPUT)} (${layers.size} nodes)`)
}

void main()
