#!/usr/bin/env node
/**
 * 包依赖门禁：把 [packages/AGENTS.md](../packages/AGENTS.md) 的「布局 / 依赖方向」
 * 变成可执行的检查。
 *
 * 为什么需要它：那些规则写了两年的文档，仍被违反了七处 —— 环、跨窗口 import、
 * 插件越权、业务包互相 import 实现。规则只写进文档时，下一批迁移会照着违反的形状
 * 继续长。这里把「包属于哪一层」「这一层能依赖哪几层」写成表，扫描真实的 import
 * 语句，**新增一条违规就让 CI 红**。
 *
 * 同时守住「包化」的两条底线：跨包只能用包名（`@nide/...`），且必须写进自己的
 * `package.json`。只看目录相对路径的 import 会让 pnpm 不知道包边界，干净检出直接
 * 解析失败；只在根 package.json 写依赖则会让每个包悄悄依赖别人装好的库。
 *
 * 设计取舍：
 * - 不依赖 TypeScript / 任何 npm 包：这是仓库卫生脚本，`node scripts/check-imports.mts`
 *   在干净的检出里就能跑（`build:host` 也是这个思路）；
 * - `import type` 不算违规：类型导入在编译时擦除，不产生运行时 / 打包耦合。只有
 *   `contracts` 例外 —— 它连类型也不许指向别的包；
 * - 存量违规进 `KNOWN` 基线：门禁只拦「新」违规。修掉一条就从基线里删一行（脚本会
 *   报「基线已过期」，防止基线变成垃圾场）。
 *
 * 已知边界：解析是「注释剥离 + 语句级正则」，不是完整 AST。它能覆盖仓库里所有
 * import 写法（含多行 import / 动态 import / 副作用 import），但**不**追踪
 * `require` 或字符串拼接出来的路径 —— 这两样在本仓库里没有出现，出现时请改用静态
 * import（那不是限制，是让工具还能看懂）。
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * 包在依赖图上属于哪一层。
 *
 * **层不在这个文件里登记**：每个包的 `package.json` 声明
 * `"nide": { "layer": "<层>" }`（与 `nide.client` / `nide.plugin` 同一套元数据），
 * 这里只定义「层 → 允许依赖的层」。少声明一个包，本脚本会直接报「没有声明
 * nide.layer」；生成图（`gen:package-graph`）也会随之缺一个节点。
 */
export type Layer =
  | 'domain'
  | 'contract'
  | 'kernel'
  | 'service'
  | 'bootstrap'
  | 'shell'
  | 'client-platform'
  | 'client-sdk'
  | 'client-seam'
  | 'client-window'
  | 'client-runtime'
  | 'client-feature'
  | 'plugin'
  | 'app'
  | 'bundle'
  | 'smoke'

/**
 * 每一层允许依赖的层。
 *
 * `domain` 是共享领域规则的根（不依赖任何包），任何层都可以 import；`contract` 是
 * 跨进程契约，同样不许依赖任何业务 / 客户端包。两者的区别只是「放什么」，不是层级：
 * 契约只描述跨进程要传的形状，领域规则是 host 与渲染进程都要算的纯逻辑。
 */
export const ALLOWED: Record<Layer, readonly Layer[]> = {
  domain: [],
  contract: [],
  kernel: ['domain', 'contract'],
  // 业务包之间不允许实现依赖；类型导入由 kind === 'type' 放行
  service: ['domain', 'contract', 'kernel'],
  bootstrap: ['domain', 'contract', 'kernel', 'service', 'bootstrap', 'smoke'],
  shell: ['domain', 'contract'],
  'client-platform': ['domain', 'contract'],
  // 插件开发者 API 只依赖契约与平台库
  'client-sdk': ['domain', 'contract', 'client-platform'],
  // 渲染机械：绑定 slot / 模块注册表，并给插件视图提供宿主上下文（所以可以依赖 sdk）
  'client-seam': ['domain', 'contract', 'client-platform', 'client-sdk', 'client-seam'],
  // 功能包：一扇窗用的界面，但不属于任何一扇窗（设置与欢迎窗口共用）
  'client-feature': ['domain', 'contract', 'client-platform', 'client-sdk', 'client-seam'],
  'client-window': [
    'domain',
    'contract',
    'client-platform',
    'client-sdk',
    'client-seam',
    'client-feature'
  ],
  'client-runtime': [
    'domain',
    'contract',
    'client-platform',
    'client-sdk',
    'client-seam',
    'client-feature',
    'client-window'
  ],
  // 插件可以 import **库**（平台 / 接缝：视图外壳、基础控件），但不许 import
  // 任何窗口或另一个功能包的实现 —— 那会把宿主窗口的改动变成插件的 break。
  plugin: ['domain', 'contract', 'client-platform', 'client-sdk', 'client-seam'],
  app: [
    'domain',
    'contract',
    'client-platform',
    'client-sdk',
    'client-seam',
    'client-feature',
    'client-window',
    'client-runtime'
  ],
  // 组合包只有 manifest + patch：没有代码，也就没有允许的依赖
  bundle: [],
  smoke: []
}

/**
 * 存量违规基线：**只许删，不许加**。
 *
 * 每一条都对应一次真实的架构欠账；门禁对它们放行，但会在输出里逐条列出来。
 * 修掉一条就把这里的一行删掉，脚本会确认基线没有过期。
 *
 * 当前为空：8 条债已于 2026-11-18 全部修完（按 DSH 的包划分答案：模块层归
 * `client-modules`、渲染机械归 `client-ui-renderer`、跨窗口共用界面归功能包、
 * 服务之间只走 ctx、插件只 import 库）。
 */
const KNOWN: readonly { from: string; to: string; reason: string }[] = []

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.mjs'])
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  '.git',
  '.agents',
  '.tmp',
  '.nide-dev',
  '.nide-dist',
  '.cordis'
])

interface Edge {
  from: string
  to: string
  kind: 'value' | 'type'
  file: string
  line: number
  spec: string
}

/** 剥离注释，保留换行（行号才对得上）。 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (two === '/*') {
      i += 2
      while (i < source.length && source.slice(i, i + 2) !== '*/') {
        if (source[i] === '\n') out += '\n'
        i++
      }
      i += 2
      continue
    }
    out += source[i]
    i++
  }
  return out
}

function lineAt(source: string, index: number): number {
  // 正则带 `(?:^|\n)` 前缀时，match.index 落在上一行的换行符上；从下一格开始数才对
  const start = source[index] === '\n' ? index + 1 : index
  let line = 1
  for (let i = 0; i < start && i < source.length; i++) if (source[i] === '\n') line++
  return line
}

interface ParsedImport {
  spec: string
  kind: 'value' | 'type'
  line: number
}

/**
 * 抽出所有 import / export ... from / 副作用 import / 动态 import。
 *
 * 语句必须从行首（可带缩进）开始：这样模板字符串或 JSX 文本里的
 * `import x from 'y'` 不会被当成依赖。
 */
function parseImports(source: string): ParsedImport[] {
  const cleaned = stripComments(source)
  const found: ParsedImport[] = []

  const fromRe =
    /(?:^|\n)[ \t]*(import|export)([^;]{0,2000}?)\bfrom[ \t]*\r?\n?[ \t]*(['"])([^'"\n]+)\3/g
  for (const match of cleaned.matchAll(fromRe)) {
    const kind = /^[ \t]+type\b/.test(match[2]) ? 'type' : 'value'
    found.push({ spec: match[4], kind, line: lineAt(cleaned, match.index ?? 0) })
  }

  const sideEffectRe = /(?:^|\n)[ \t]*import[ \t]*(['"])([^'"\n]+)\1/g
  for (const match of cleaned.matchAll(sideEffectRe)) {
    found.push({ spec: match[2], kind: 'value', line: lineAt(cleaned, match.index ?? 0) })
  }

  const dynamicRe = /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g
  for (const match of cleaned.matchAll(dynamicRe)) {
    found.push({ spec: match[2], kind: 'value', line: lineAt(cleaned, match.index ?? 0) })
  }

  return found
}

async function walk(dir: string, files: string[] = []): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(path.join(dir, entry.name), files)
    } else if (SOURCE_EXT.has(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name))
    }
  }
  return files
}

function toKey(rel: string): string | undefined {
  const parts = rel.split('/')
  if (parts[0] === 'packages') {
    if (parts[1] === 'plugins' && parts[2]) return `packages/plugins/${parts[2]}`
    if (parts[1]) return `packages/${parts[1]}`
    return undefined
  }
  if (rel.startsWith('apps/desktop/renderer/')) return 'apps/desktop/renderer'
  return undefined
}

async function readPackageNames(): Promise<{
  names: Map<string, string>
  packageNameByKey: Map<string, string>
  layers: Map<string, Layer>
  declared: Map<string, Set<string>>
}> {
  const names = new Map<string, string>()
  const packageNameByKey = new Map<string, string>()
  const layers = new Map<string, Layer>()
  const declared = new Map<string, Set<string>>()
  const dirs: string[] = []
  for (const entry of await readdir(path.join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'plugins' || entry.name === 'bundle') {
      // 这两类包在下一层：packages/plugins/<name>、packages/bundle/<name>
      for (const child of await readdir(path.join(ROOT, 'packages', entry.name), {
        withFileTypes: true
      })) {
        if (child.isDirectory()) dirs.push(`packages/${entry.name}/${child.name}`)
      }
      continue
    }
    dirs.push(`packages/${entry.name}`)
  }
  for (const dir of dirs) {
    try {
      const raw = await readFile(path.join(ROOT, dir, 'package.json'), 'utf8')
      const pkg = JSON.parse(raw) as {
        name?: string
        nide?: { layer?: unknown }
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }
      if (pkg.name) {
        names.set(pkg.name, dir)
        packageNameByKey.set(dir, pkg.name)
      }
      // 层由包自己声明；值不合法时按「未分类」处理，由 main 报错
      if (typeof pkg.nide?.layer === 'string') layers.set(dir, pkg.nide.layer as Layer)
      // 依赖声明：跨包 import 必须能在自己的 package.json 里找到（只查名字，不查版本）
      const deps = new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {})
      ])
      declared.set(dir, deps)
    } catch {
      // 没有 package.json 的目录不是包（例如 bundle 之外的临时目录），跳过
    }
  }
  // 渲染进程引导壳不是 workspace 包（apps/ 下没有 package.json），按装配层算
  layers.set('apps/desktop/renderer', 'app')
  return { names, packageNameByKey, layers, declared }
}

/** 把说明符解析成包 key；解析不出来（react / cordis / node:）返回 undefined。 */
function resolveSpecifier(
  spec: string,
  fileRel: string,
  names: Map<string, string>
): string | undefined {
  if (spec.startsWith('.')) {
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(fileRel), spec.replace(/[?#].*$/, ''))
    )
    return toKey(resolved)
  }
  if (spec.startsWith('@nide/')) {
    // 最长前缀匹配：@nide/client-ui-main/settings 应该落到 client-ui-main 而不是 client-ui
    let best: string | undefined
    for (const name of names.keys()) {
      if (best && name.length <= best.length) continue
      if (spec === name || spec.startsWith(`${name}/`)) best = name
    }
    return best ? names.get(best) : undefined
  }
  // contracts 的内部子路径映射；对别的包没有意义
  if (spec.startsWith('#project/')) return 'packages/domain'
  return undefined
}

function layerOf(layers: Map<string, Layer>, key: string): Layer | undefined {
  return layers.get(key)
}

const CONTRACT_FORBIDDEN = /^(node:|electron(\/|$))/

interface ContractViolation {
  file: string
  line: number
  spec: string
}

/** 扫描全部包与它们的跨包 import；`gen:package-graph` 也用这一份结果，避免两套解析。 */
export async function scan(): Promise<{
  edges: Edge[]
  contractViolations: ContractViolation[]
  layers: Map<string, Layer>
  packageNameByKey: Map<string, string>
  declared: Map<string, Set<string>>
}> {
  const { names, packageNameByKey, layers, declared } = await readPackageNames()
  const files = [
    ...(await walk(path.join(ROOT, 'packages'))),
    ...(await walk(path.join(ROOT, 'apps/desktop/renderer')))
  ]
  const edges: Edge[] = []
  const contractViolations: ContractViolation[] = []

  for (const file of files) {
    const fileRel = path.relative(ROOT, file).split(path.sep).join('/')
    const fileKey = toKey(fileRel)
    if (!fileKey) continue

    const source = await readFile(file, 'utf8')
    for (const { spec, kind, line } of parseImports(source)) {
      const to = resolveSpecifier(spec, fileRel, names)
      if (!to || to === fileKey) continue
      edges.push({ from: fileKey, to, kind, file: fileRel, line, spec })
    }

    // 纯层的额外约束：domain 什么都不许碰；contract 只许用 domain，不许碰 Node / Electron
    // （包内相对导入与 #project/* 不算跨包）
    if (fileKey === 'packages/contracts' || fileKey === 'packages/domain') {
      for (const { spec, line } of parseImports(source)) {
        const to = resolveSpecifier(spec, fileRel, names)
        const isContractToDomain = fileKey === 'packages/contracts' && to === 'packages/domain'
        if (CONTRACT_FORBIDDEN.test(spec) || (to && to !== fileKey && !isContractToDomain)) {
          contractViolations.push({ file: fileRel, line, spec })
        }
      }
    }
  }

  return { edges, contractViolations, layers, packageNameByKey, declared }
}

function findCycles(edges: Edge[]): string[][] {
  const graph = new Map<string, Set<string>>()
  for (const edge of edges) {
    if (edge.kind === 'type') continue
    if (!graph.has(edge.from)) graph.set(edge.from, new Set())
    graph.get(edge.from)!.add(edge.to)
  }

  const cycles = new Map<string, string[]>()
  const visit = (node: string, stack: string[], seen: Set<string>): void => {
    const next = graph.get(node)
    if (!next) return
    for (const target of next) {
      const at = stack.indexOf(target)
      if (at >= 0) {
        const cycle = [...stack.slice(at), target]
        // 旋转到最小节点开头去重，避免同一个环按不同起点报多次
        const body = cycle.slice(0, -1)
        const pivot = body.indexOf([...body].sort()[0])
        const canonical = [...body.slice(pivot), ...body.slice(0, pivot)]
        cycles.set(canonical.join(' > '), [...canonical, canonical[0]])
        continue
      }
      if (seen.has(target)) continue
      visit(target, [...stack, target], new Set([...seen, target]))
    }
  }
  for (const node of graph.keys()) visit(node, [node], new Set([node]))
  return [...cycles.values()]
}

async function main(): Promise<void> {
  const { edges, contractViolations, layers, packageNameByKey, declared } = await scan()
  const errors: string[] = []
  const warnings: string[] = []

  /*
   * 两条「包化」硬规则（2026-11-26）：
   * 1. 跨包一律用包名（`@nide/...`），相对路径只能指向包内 —— 否则包边界只是目录；
   * 2. 跨包 import 必须在自己的 package.json 里声明依赖 —— 否则 pnpm 不建链接，
   *    开发机能跑、干净检出跑不了。
   */
  for (const edge of edges) {
    if (edge.spec.startsWith('.')) {
      errors.push(
        `${edge.file}:${edge.line} 跨包相对导入：${edge.spec}（改用 ${packageNameByKey.get(edge.to) ?? edge.to} 的包名）`
      )
    }

    if (!edge.from.startsWith('packages/')) continue
    const targetName = packageNameByKey.get(edge.to)
    if (!targetName) continue
    if (!declared.get(edge.from)?.has(targetName)) {
      errors.push(
        `${edge.file}:${edge.line} ${edge.from} 没有声明依赖 ${targetName}（在它的 package.json 里加 "dependencies"）`
      )
    }
  }

  for (const item of contractViolations) {
    errors.push(
      `${item.file}:${item.line} contracts 只能自包含（不许别的包 / Node / Electron）：import '${item.spec}'`
    )
  }

  const keyOf = (edge: Edge): string => `${edge.from} -> ${edge.to}`
  const known = new Map(KNOWN.map((item) => [`${item.from} -> ${item.to}`, item]))
  const hitKnown = new Set<string>()

  for (const edge of edges) {
    const pair = keyOf(edge)
    const fromLayer = layerOf(layers, edge.from)
    const toLayer = layerOf(layers, edge.to)

    if (!fromLayer) {
      errors.push(
        `${edge.file}:${edge.line} 包 ${edge.from} 没有声明层（在它的 package.json 里加 "nide": { "layer": ... }，层名见 packages/AGENTS.md）`
      )
      continue
    }
    if (!toLayer) {
      errors.push(`${edge.file}:${edge.line} ${edge.from} 依赖了未声明层的包 ${edge.to}`)
      continue
    }

    const allowed = ALLOWED[fromLayer]
    const typeOnly = edge.kind === 'type'
    // 类型导入不产生运行时 / 打包耦合，除 contracts 外允许跨层
    const violates = !allowed.includes(toLayer) && !(typeOnly && edge.from !== 'packages/contracts')

    if (!violates) continue

    const debt = known.get(pair)
    if (debt) {
      hitKnown.add(pair)
      continue
    }
    errors.push(
      `${edge.file}:${edge.line} ${edge.from}（${fromLayer}）-> ${edge.to}（${toLayer}）：${edge.spec}`
    )
  }

  // `contracts` 的 TODO 在 to 里带了「外部:」前缀，那条也直接算错误（没有基线）
  for (const [pair, item] of known) {
    if (!hitKnown.has(pair))
      warnings.push(`基线已过期：${pair}（${item.reason}）不再出现，请删掉这一行`)
  }

  const cycles = findCycles(edges)
  const newCycles = cycles.filter((cycle) =>
    cycle.slice(0, -1).every((node, index) => {
      const pair = `${node} -> ${cycle[(index + 1) % (cycle.length - 1)]}`
      return !known.has(pair)
    })
  )

  console.log('包依赖门禁（packages/AGENTS.md 的可执行版本）\n')

  if (errors.length) {
    console.log(`✗ 新增违规 ${errors.length} 条\n`)
    for (const error of errors) console.log(`  ${error}`)
    console.log('')
  }

  if (newCycles.length) {
    console.log(`✗ 新增依赖环 ${newCycles.length} 个\n`)
    for (const cycle of newCycles) console.log(`  ${cycle.join(' -> ')}`)
    console.log('')
  }

  if (KNOWN.length) {
    console.log(`· 已知债务 ${KNOWN.length} 条（基线放行，不阻塞；修一条删一行）`)
    for (const item of KNOWN) {
      const hit = hitKnown.has(`${item.from} -> ${item.to}`) ? '' : '  [已不出现]'
      console.log(`    ${item.from} -> ${item.to}  ${item.reason}${hit}`)
    }
    console.log('')
  }

  for (const warning of warnings) console.log(`! ${warning}`)

  const total = errors.length + newCycles.length
  console.log(
    total === 0
      ? `\n✓ 无新增违规（扫描 ${new Set(edges.map((edge) => edge.from)).size} 个包 / ${edges.length} 条跨包 import）`
      : `\n✗ ${total} 个问题`
  )
  process.exitCode = total === 0 ? 0 : 1
}

// 只有被直接执行时才跑检查：`gen:package-graph` 会 import 本文件复用 scan()
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main()
}
