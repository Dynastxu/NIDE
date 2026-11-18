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
 * 插件后端的子进程入口。
 *
 * 它不是被静态 import 的（宿主按路径 `fork` 它），所以 TS 顺着依赖树走不到，
 * 必须显式加进编译根；否则打包版里 `fork` 一个不存在的 `worker.js`。
 */
const backendWorker = path.join(root, 'packages', 'plugin-backend', 'src', 'worker.ts')

/**
 * 安装式插件的组合行入口：行是运行时写进 profile patch 的，TS 走不到，
 * 必须显式作为编译根（否则打包版里那行指向一个不存在的 `plugin-shim.js`）。
 */
const pluginShim = path.join(root, 'packages', 'host', 'src', 'plugin-shim.ts')

/**
 * profile 与组合包里的插件都是**动态 import** 的（loader 按 YAML 里的路径加载），
 * TS 顺着静态依赖树走不到它们，所以显式加进编译根。
 *
 * 只认 `{{NIDE_ROOT}}/.../src/index.ts` 这种形状：那正是仓库内的插件包。
 * 扫 `packages/bundle/<name>/cordis.patch.yml`；profile 的模板由 boot 代码生成，
 * 其中唯一的外部入口（hello）作为固定根单独加进来。
 */
function dynamicEntries(): string[] {
  const entries = new Set<string>()

  const scan = (file: string): void => {
    const text = fs.readFileSync(file, 'utf-8')
    for (const match of text.matchAll(/\{\{NIDE_ROOT\}\}\/([^\s'"]+\.ts)/g)) {
      entries.add(path.join(root, match[1]))
    }
  }

  const bundlesRoot = path.join(root, 'packages', 'bundle')
  if (fs.existsSync(bundlesRoot)) {
    for (const name of fs.readdirSync(bundlesRoot)) {
      const file = path.join(bundlesRoot, name, 'cordis.patch.yml')
      if (fs.existsSync(file)) scan(file)
    }
  }

  // profile 模板由 boot 生成，里面的 hello 行不会出现在任何 YAML 里
  entries.add(path.join(root, 'packages', 'hello', 'src', 'index.ts'))

  return [...entries]
}

function fail(message: string): never {
  console.error(`[build-host] ${message}`)
  process.exit(1)
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

const roots = [entry, backendWorker, pluginShim, ...dynamicEntries()]
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
 * - `imports` 映射（`packages/domain/src/project` 的 `#project/*`）：**必须**带上，
 *   否则 `#project/store` 这种 bare specifier 解析不了。
 *
 * 映射目标是 `.ts`（源码里就是给类型剥离用的），发射后要改成 `.js`。
 */
const markerRoots = [
  path.join(root, 'packages', 'contracts', 'src'),
  path.join(root, 'packages', 'domain', 'src')
]
for (const markerRoot of markerRoots) {
  for (const name of fs.readdirSync(markerRoot)) {
    const marker = path.join(markerRoot, name, 'package.json')
    if (!fs.existsSync(marker)) continue

    const raw = JSON.parse(fs.readFileSync(marker, 'utf-8')) as { imports?: unknown }
    if (!raw.imports) continue

    const rewritten = JSON.parse(JSON.stringify(raw).replaceAll('.ts"', '.js"')) as object
    const target = path.join(
      outDir,
      path.relative(root, path.join(markerRoot, name)),
      'package.json'
    )
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify(rewritten, null, 2)}\n`, 'utf-8')
  }
}

/**
 * 组合包（`packages/bundle/*`）只有 `package.json` 与 `cordis.patch.yml`，
 * 没有可编译的源码：它们必须在产物根里，`{{NIDE_ROOT}}` 展开后 boot 才找得到。
 * 少了这一步，打包版启动会报 `bundle "..." not found`。
 */
const bundlesSource = path.join(root, 'packages', 'bundle')
if (fs.existsSync(bundlesSource)) {
  for (const name of fs.readdirSync(bundlesSource)) {
    for (const file of ['package.json', 'cordis.patch.yml']) {
      const source = path.join(bundlesSource, name, file)
      if (!fs.existsSync(source)) continue
      const target = path.join(outDir, 'packages', 'bundle', name, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.cpSync(source, target)
    }
  }
}

/**
 * 插件包不是纯 TS：manifest.json、`package.nls*.json`、locales、`dist/client.js`
 * 都是运行时要读的文件（插件服务按目录定位界面入口与客户端 bundle）。
 * `src/` 已经由 TS 编译，其余原样复制到产物根。
 */
const pluginsSource = path.join(root, 'packages', 'plugins')
if (fs.existsSync(pluginsSource)) {
  for (const name of fs.readdirSync(pluginsSource)) {
    const source = path.join(pluginsSource, name)
    if (!fs.statSync(source).isDirectory()) continue
    if (name.startsWith('.') || name === 'node_modules') continue

    for (const entry of fs.readdirSync(source)) {
      if (entry === 'src' || entry === 'node_modules' || entry.startsWith('.')) continue
      fs.cpSync(path.join(source, entry), path.join(outDir, 'packages', 'plugins', name, entry), {
        recursive: true
      })
    }
  }
}

console.log(`[build-host] built ${path.relative(root, outDir)}`)
