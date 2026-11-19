/**
 * 包**内部**的域分层门禁（与 `check-imports` 的包间分层互补）。
 *
 * DSH 的做法：一个客户端功能包内部按「域」分目录，域之间**不许互相 import**；
 * 只有包内共享目录（`shared/`）与装配点（`index` / `App` / `MainApp`，以及声明为
 * 装配域的 `layout` / `host-view`）可以跨域。这样「改编辑器」不会悄悄把文件树也
 * 拖下水，单域代码也始终可以整体搬走。
 *
 * 规则：
 * 1. 域 = `src/` 下的一级目录，**除了**配置里声明为共享的目录（`shared/`、`stores/`）；
 * 2. 共享目录谁都能 import；域里的文件夹可以 import 自己域内的一切；
 * 3. 跨域只允许出现在装配点，或**从**装配域出发；
 * 4. 只算运行时 import：`import type` 不产生耦合，与包间规则一致。
 *
 * 存量违规进 `KNOWN` 基线（只许删不许加），修一条删一行。
 *
 *   node scripts/check-package-domains.mts
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

interface PackageConfig {
  /** 包目录（相对仓库根） */
  dir: string
  /** 谁都能 import 的目录（包内共享） */
  shared: readonly string[]
  /** 允许跨域装配的 `src/` 根文件（`index.ts(x)` 永远算） */
  assemblyFiles: readonly string[]
  /** 允许**从**这里跨域装配的域（布局 / 视图分发表这类组合层） */
  assemblyDomains: readonly string[]
}

/**
 * 受规则约束的包。
 *
 * 只覆盖**窗口 / 功能包**：库（client-kit / client-ui-renderer / slots / modules）
 * 本身就是让别处 import 的一组目录，套这条规则只会把库拆碎。DSH 也是把域规则
 * 用在带 `apply` 装配点的客户端功能包上。
 */
const PACKAGES: readonly PackageConfig[] = [
  {
    dir: 'packages/client-ui-main',
    shared: ['shared', 'stores'],
    assemblyFiles: ['App.tsx', 'MainApp.tsx'],
    assemblyDomains: ['layout', 'host-view']
  },
  {
    dir: 'packages/client-ui-settings',
    shared: ['shared'],
    // 设置树 / 页面表是装配数据，不是域
    assemblyFiles: ['SettingsApp.tsx', 'pages.ts'],
    assemblyDomains: []
  },
  {
    dir: 'packages/client-ui-welcome',
    shared: ['shared'],
    assemblyFiles: ['WelcomeApp.tsx'],
    assemblyDomains: []
  },
  {
    dir: 'packages/client-ui-plugins',
    shared: [],
    assemblyFiles: [],
    assemblyDomains: []
  }
]

/**
 * 存量违规基线：**只许删，不许加**。
 *
 * 每一条都是真实的耦合，改它要动状态与交互顺序，所以先钉住不扩散。
 */
export const KNOWN: readonly { from: string; to: string; reason: string }[] = []

interface Violation {
  packageDir: string
  file: string
  fromDomain: string
  toDomain: string
  spec: string
}

/** 去掉注释，避免把注释里的例子当成 import */
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

interface ImportSpec {
  spec: string
  kind: 'value' | 'type'
}

/** 与 check-imports 同一套语句级解析（多行 import / 动态 import / 副作用 import） */
function parseImports(source: string): ImportSpec[] {
  const cleaned = stripComments(source)
  const found: ImportSpec[] = []
  const fromRe =
    /(?:^|\n)[ \t]*(import|export)([^;]{0,2000}?)\bfrom[ \t]*\r?\n?[ \t]*(['"])([^'"\n]+)\3/g
  for (const match of cleaned.matchAll(fromRe)) {
    found.push({ spec: match[4], kind: /^[ \t]+type\b/.test(match[2]) ? 'type' : 'value' })
  }
  for (const match of cleaned.matchAll(/(?:^|\n)[ \t]*import[ \t]*(['"])([^'"\n]+)\1/g)) {
    found.push({ spec: match[2], kind: 'value' })
  }
  for (const match of cleaned.matchAll(/\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g)) {
    found.push({ spec: match[2], kind: 'value' })
  }
  return found
}

async function walk(dir: string, files: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, files)
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(full)
  }
  return files
}

async function packageNameOf(dir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path.join(ROOT, dir, 'package.json'), 'utf8')
    return (JSON.parse(raw) as { name?: string }).name
  } catch {
    return undefined
  }
}

/**
 * 把一个说明符解析成「包内路径」；解析不出来（外部包 / 跑出包外）返回 undefined。
 *
 * 包内别名（`@nide/client-ui-main/explorer/...`）与相对路径都要认：核心 UI 两者
 * 混用，只看相对路径会漏掉大半。
 */
function resolveInside(
  spec: string,
  fileRel: string,
  pkgName: string | undefined
): string | undefined {
  if (spec.startsWith('.')) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), spec))
  }
  if (!pkgName) return undefined
  if (spec === pkgName) return 'index'
  if (spec.startsWith(`${pkgName}/`)) return spec.slice(pkgName.length + 1)
  return undefined
}

async function main(): Promise<void> {
  const violations: Violation[] = []
  const known = new Map(KNOWN.map((item) => [`${item.from} -> ${item.to}`, item]))
  const hitKnown = new Set<string>()
  const errors: string[] = []
  const warnings: string[] = []
  let scanned = 0

  for (const config of PACKAGES) {
    const src = path.join(ROOT, config.dir, 'src')
    const entries = await readdir(src, { withFileTypes: true }).catch(() => null)
    if (!entries) continue
    const dirs = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
    const shared = new Set(config.shared)
    const domains = new Set([...dirs].filter((name) => !shared.has(name)))
    const pkgName = await packageNameOf(config.dir)
    const files = await walk(src)

    for (const file of files) {
      const fileRel = path.relative(src, file).split(path.sep).join('/')
      scanned++
      const segments = fileRel.split('/')
      const fromDomain = segments.length > 1 ? segments[0] : ''
      const isRootAssembly =
        fromDomain === '' &&
        (segments[0].startsWith('index.') || config.assemblyFiles.includes(segments[0]))
      const isAssemblyDomain = fromDomain !== '' && config.assemblyDomains.includes(fromDomain)
      if (isRootAssembly || isAssemblyDomain) continue

      const source = await readFile(file, 'utf8')
      for (const { spec, kind } of parseImports(source)) {
        if (kind === 'type') continue
        const resolved = resolveInside(spec, fileRel, pkgName)
        if (!resolved || resolved.startsWith('..')) continue

        const targetSegments = resolved.split('/')
        // 目标是 `src/` 根文件（例如 `MainApp`）：不算跨域
        if (targetSegments.length < 2) continue
        const toDomain = targetSegments[0]
        if (shared.has(toDomain)) continue
        if (!domains.has(toDomain)) continue
        if (toDomain === fromDomain) continue
        if (fromDomain === '') continue // 根文件只能装配根文件；域只能被装配点 import

        violations.push({
          packageDir: config.dir,
          file: `${config.dir}/src/${fileRel}`,
          fromDomain,
          toDomain,
          spec
        })
      }
    }
  }

  for (const violation of violations) {
    const pair = `${violation.packageDir}: ${violation.fromDomain} -> ${violation.toDomain}`
    if (known.has(pair)) {
      hitKnown.add(pair)
      continue
    }
    errors.push(
      `${violation.file} 域 ${violation.fromDomain} 直接 import 了域 ${violation.toDomain}（${violation.spec}）——跨域只能经 shared / 装配点`
    )
  }

  for (const [pair, item] of known) {
    if (!hitKnown.has(pair))
      warnings.push(`基线已过期：${pair}（${item.reason}）不再出现，请删掉这一行`)
  }

  console.log('包内域分层门禁（跨域只能经 shared / 装配点）\n')

  if (errors.length) {
    console.log(`✗ 新增跨域 import ${errors.length} 条\n`)
    for (const error of errors) console.log(`  ${error}`)
    console.log('')
  }

  if (KNOWN.length) {
    console.log(`· 已知跨域 ${KNOWN.length} 条（基线放行，修一条删一行）`)
    for (const item of KNOWN) {
      const hit = hitKnown.has(`${item.from} -> ${item.to}`) ? '' : '  [已不出现]'
      console.log(`    ${item.from} -> ${item.to}  ${item.reason}${hit}`)
    }
    console.log('')
  }

  for (const warning of warnings) console.log(`! ${warning}`)

  console.log(
    errors.length === 0
      ? `\n✓ 无新增跨域（扫描 ${PACKAGES.length} 个包 / ${scanned} 个文件）`
      : `\n✗ ${errors.length} 个问题`
  )
  process.exitCode = errors.length === 0 ? 0 : 1
}

void main()
