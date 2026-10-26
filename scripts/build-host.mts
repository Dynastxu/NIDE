/**
 * 编译 host（源码 → 可打包的 JS）。
 *
 *   node scripts/build-host.ts
 *
 * 为什么是「编译成目录」而不是「打包成单文件」：profile 里的 `cordis.yml` 指向的是
 * **插件包路径**（`packages/hello/src/index.ts`），loader 在运行时按路径 `import()`。
 * 换成单文件 bundle 就得把动态 import 一起改掉；保留目录结构最省事，也让
 * `{{NIDE_ROOT}}` 的语义不变。
 *
 * 用 TypeScript 的 Node API 而不是 spawn `tsc`：构建脚本本身要能在受限环境里跑
 * （沙箱禁止 spawn 子进程）。
 *
 * 产物布局（与源码同构，`out/host` 就是打包后的「仓库根」）：
 *
 *   out/host/packages/host/src/index.js     ← 入口
 *   out/host/packages/hello/src/index.js    ← profile 里引用的插件
 *   out/host/packages/contracts/src/...                 ← 共享层
 *   out/host/profiles/desktop/...           ← profile 模板（.ts → .js 已改写）
 *   out/host/package.json                   ← {"type":"module"}
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'

const root = process.cwd()
const outDir = path.join(root, 'out', 'host')

/** 编译入口：host 进程。它 import 到的东西由 TS 自己顺着依赖树编出来 */
const entry = path.join(root, 'packages', 'host', 'src', 'index.ts')

/**
 * profile 里的插件是**动态 import** 的（loader 按 `cordis.yml` 里的路径加载），
 * TS 顺着静态依赖树走不到它们，所以显式加进编译根。
 *
 * 只认 `{{NIDE_ROOT}}/.../src/index.ts` 这种形状：那正是仓库内的插件包。
 */
function profileEntries(): string[] {
  const profilesRoot = path.join(root, 'profiles')
  const entries = new Set<string>()

  for (const name of fs.readdirSync(profilesRoot)) {
    const file = path.join(profilesRoot, name, 'cordis.yml')
    if (!fs.existsSync(file)) continue

    const text = fs.readFileSync(file, 'utf-8')
    for (const match of text.matchAll(/\{\{NIDE_ROOT\}\}\/([^\s'"]+\.ts)/g)) {
      entries.add(path.join(root, match[1]))
    }
  }

  return [...entries]
}

function fail(message: string): never {
  console.error(`[build-host] ${message}`)
  process.exit(1)
}

function* walk(dir: string): Generator<string> {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name)
    if (name.isDirectory()) yield* walk(full)
    else yield full
  }
}

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  /*
   * 统一发射 ESM，而不是 NodeNext。
   *
   * NodeNext 会按「最近的 package.json 有没有 type: module」逐文件决定 CJS / ESM ——
   * 共享层里没有 marker 的目录（比如 host-rpc）就会被编成 CJS，而产物根上的
   * package.json 是 ESM，运行时直接对不上。这里统一 ESM，格式问题只留在
   * 「产物根必须是 type: module」这一处，由下面的 package.json 保证。
   */
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ['lib.es2023.d.ts'],
  rootDir: root,
  outDir,
  noEmit: false,
  declaration: false,
  sourceMap: false,
  // 源码用显式 `.ts` 后缀 import（Node 的类型剥离要求），发射时改写成 `.js`
  rewriteRelativeImportExtensions: true,
  esModuleInterop: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  strict: true,
  types: ['node']
}

const roots = [entry, ...profileEntries()]
for (const rootFile of roots) {
  if (!fs.existsSync(rootFile)) fail(`entry not found: ${rootFile}`)
}

fs.rmSync(outDir, { recursive: true, force: true })

const program = ts.createProgram(roots, options)
const emitResult = program.emit()

const diagnostics = ts
  .getPreEmitDiagnostics(program)
  .concat(emitResult.diagnostics)
  .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)

if (diagnostics.length > 0) {
  for (const diagnostic of diagnostics.slice(0, 20)) {
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    if (diagnostic.file && typeof diagnostic.start === 'number') {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      const relative = path.relative(root, diagnostic.file.fileName)
      console.error(`[build-host] ${relative}:${line + 1}:${character + 1} ${text}`)
    } else {
      console.error(`[build-host] ${text}`)
    }
  }
  fail(`${diagnostics.length} compile error(s)`)
}

/**
 * `out/host` 是打包后的「仓库根」，所以顶层要标成 ESM。
 *
 * 少了这一个文件，Node 会把所有 `.js` 当成 CJS（最近的 package.json 是仓库根，
 * 而它没有 `"type": "module"`），第一行 `import` 就炸。
 */
fs.writeFileSync(
  path.join(outDir, 'package.json'),
  `${JSON.stringify({ name: 'nide-host', private: true, type: 'module' }, null, 2)}\n`,
  'utf-8'
)

/**
 * 共享层里的 `package.json` 有两类作用：
 * - `{"type":"module"}`：产物根那份已经覆盖，不必复制；
 * - `imports` 映射（`packages/contracts/src/project` 的 `#project/*`）：**必须**带上，
 *   否则 `#project/store` 这种 bare specifier 解析不了。
 *
 * 映射目标是 `.ts`（源码里就是给类型剥离用的），发射后要改成 `.js`。
 */
const sharedRoot = path.join(root, 'packages', 'contracts', 'src')
for (const name of fs.readdirSync(sharedRoot)) {
  const marker = path.join(sharedRoot, name, 'package.json')
  if (!fs.existsSync(marker)) continue

  const raw = JSON.parse(fs.readFileSync(marker, 'utf-8')) as { imports?: unknown }
  if (!raw.imports) continue

  const rewritten = JSON.parse(JSON.stringify(raw).replaceAll('.ts"', '.js"')) as object
  const target = path.join(outDir, 'packages', 'contracts', 'src', name, 'package.json')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(rewritten, null, 2)}\n`, 'utf-8')
}

/**
 * profile 模板要一起进产物：打包版由 host 传 `--dist-root`，模板就从这里取，
 * `{{NIDE_ROOT}}` 也展开成这里。模板里的插件路径指向源码（`.ts`），一并改写成 `.js`。
 */
const profilesSource = path.join(root, 'profiles')
const profilesTarget = path.join(outDir, 'profiles')
if (!fs.existsSync(profilesSource)) fail('profiles/ not found')

fs.cpSync(profilesSource, profilesTarget, { recursive: true })
for (const file of walk(profilesTarget)) {
  if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue
  const text = fs.readFileSync(file, 'utf-8')
  fs.writeFileSync(file, text.replaceAll('/src/index.ts', '/src/index.js'), 'utf-8')
}

console.log(`[build-host] built ${path.relative(root, outDir)}`)
