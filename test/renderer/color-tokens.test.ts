import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 配色 token 的护栏。
 *
 * 配色现在只有**一份语义 token 表**：深色值在 `apps/desktop/renderer/src/assets/index.css`
 * 的 `@theme` 里，浅色值是 `assets/light.css` 对同一组 token 的覆盖。组件只写角色名
 * （`bg-surface` / `text-fg-muted` / `border-line`），编译出来是 `var(--color-…)`。
 *
 * 这条用例守四件事，每一件都对应一次真实踩过的坑：
 *
 * 1. **两套值成对**：token 加了深色忘了浅色，浅色下就会露出深色值。以前那套"逐条翻译"
 *    的写法漏了 24 个类（`hover:bg-zinc-800/60`、`disabled:bg-zinc-700`、
 *    `text-emerald-400` …），漏掉一条不会有任何报错 —— 只有真去点一下才看得见。
 * 2. **不许退回原始色阶**：`bg-zinc-800` 这类类名一旦重新出现，就等于在组件里写死了
 *    一套配色，浅色主题立刻漏翻。
 * 3. **颜色类必须落在 token 上**：拼错的 token（`bg-surfce`）不报错，只会静默无色，
 *    所以"名字不认识"在这里算失败。
 * 4. **浅色主题不许再有第二条规则**：`light.css` 重新出现 `.theme-light .bg-xxx`
 *    这类选择器规则，就意味着又回到了"逐条翻译"的老路 —— 那正是漏翻的来源。
 *
 * 为什么不用 ESLint：仓库里已经有「靠源码约定失败」的 vitest 用例（见
 * `scrollbar-theme.test.ts`、`client-roster.test.ts`），把护栏放在同一处更好读。
 */

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

const INDEX_CSS = 'apps/desktop/renderer/src/assets/index.css'
const LIGHT_CSS = 'apps/desktop/renderer/src/assets/light.css'

const SOURCE_GLOBS = ['apps/**/*.ts', 'apps/**/*.tsx', 'packages/**/*.ts', 'packages/**/*.tsx']
const IGNORED_DIRS = ['node_modules', 'dist', 'out', '.nide-dev', '.nide-dist']

/**
 * 两个主题下**允许同值**的 token。
 *
 * 主色实心面与它上面的白字：`#2563eb` 压白字两种主题都成立（5.2:1），换值只会更差。
 * 危险色实心面同理 —— 它在两套配色里都压着白字。
 */
const SAME_IN_BOTH_PALETTES = new Set([
  '--color-accent',
  '--color-on-accent',
  '--color-danger',
  // 中性中间调：一档灰在深底与浅底上都站得住（4.7:1），没必要为它编两个值
  '--color-fg-subtle'
])

/**
 * 长得像颜色、其实是别的意思的工具类尾部。
 *
 * 只登记源码里**真的出现过**的那些：这里多一行意味着少一条护栏，所以宁可让新出现的
 * 非颜色类先在用例里红一次、再决定要不要豁免。
 */
const NON_COLOR_NAMES = new Set([
  // 字号
  'xs',
  'sm',
  'base',
  'lg',
  'xl',
  '2xl',
  // 对齐
  'left',
  'center',
  'right',
  'justify',
  // 线型 / 线宽 / 方向
  'transparent',
  'current',
  'none',
  'solid',
  'dashed',
  'dotted',
  'double',
  'hidden',
  't',
  'b',
  'l',
  'r',
  'x',
  'y',
  '2',
  't-2',
  'b-2',
  // 投影尺寸
  'lg',
  'xl'
])

const PALETTE_NAMES =
  'zinc|slate|gray|neutral|stone|blue|sky|indigo|violet|purple|fuchsia|pink|rose|red|orange|amber|yellow|lime|green|emerald|teal|cyan'

/** Tailwind 的默认色板：出现即说明组件又写死了配色 */
const RAW_PALETTE = new RegExp(
  `(?<![\\w-])(?:[a-z-]+:)*(?:bg|text|border[a-z-]*|divide|ring|shadow|accent|fill|stroke|outline|decoration|placeholder|caret)-(?:${PALETTE_NAMES})(?:-\\d{2,3})?(?:\\/\\d{1,3})?(?![\\w-])`,
  'g'
)

/** 源码里的颜色类：`util-name`（允许变体前缀与透明度） */
const COLOR_UTILITY = new RegExp(
  `(?<![\\w/:-])(?:[a-z-]+:)*(?<util>bg|text|border(?:-[tblrxyse]{1,2})?|divide|ring|shadow|accent|fill|stroke|outline|decoration|placeholder|caret)-(?<name>[a-z][a-z0-9-]*?)(?:\\/\\d{1,3})?(?![\\w-])`,
  'g'
)

function read(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), 'utf-8')
}

/** 去掉注释后再检查：注释里解释"为什么不再写 `bg-zinc-800`"是正常的，不能让它失败 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** 取 `selector { ... }` 的声明体：@theme 与浅色表里都没有嵌套的大括号，正则够用 */
function ruleBody(css: string, selectorPattern: string): string {
  const match = css.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`))
  if (!match) throw new Error(`在 ${selectorPattern} 上找不到规则块`)
  return match[1]
}

/** 规则块里声明的 token 名（按出现顺序去重） */
function tokenNames(declarations: string): string[] {
  return [...new Set([...declarations.matchAll(/(--color-[a-z-]+)\s*:/g)].map((m) => m[1]))]
}

function tokenValue(declarations: string, token: string): string {
  const match = declarations.match(new RegExp(`${token}\\s*:\\s*([^;]+);`))
  return match ? match[1].trim() : ''
}

function sourceFiles(): string[] {
  return SOURCE_GLOBS.flatMap((glob) => fs.globSync(glob, { cwd: repoRoot }))
    .map((file) => file.split(path.sep).join('/'))
    .filter((file) => !IGNORED_DIRS.some((dir) => file.split('/').includes(dir)))
    .sort()
}

const darkCss = stripComments(read(INDEX_CSS))
const lightCss = stripComments(read(LIGHT_CSS))
const darkDeclarations = ruleBody(darkCss, '@theme')
const lightDeclarations = ruleBody(lightCss, ':root\\.theme-light')
const darkTokens = tokenNames(darkDeclarations)
const lightTokens = tokenNames(lightDeclarations)
const tokenKeys = new Set(darkTokens.map((token) => token.slice('--color-'.length)))
const sources = sourceFiles()

describe('配色 token', () => {
  it('深色与浅色声明同一组 token', () => {
    expect([...lightTokens].sort()).toEqual([...darkTokens].sort())
    expect(darkTokens.length).toBeGreaterThan(0)
  })

  it('两套配色里该变的都变了', () => {
    const unchanged = darkTokens
      .filter((token) => !SAME_IN_BOTH_PALETTES.has(token))
      .filter(
        (token) => tokenValue(darkDeclarations, token) === tokenValue(lightDeclarations, token)
      )

    // 同值多半是复制过去忘了改：浅色主题会看起来"没生效"
    expect(unchanged).toEqual([])
  })

  it('画布底色就是窗口底色', () => {
    // 两者不一致时，拖动改大窗口会在新露出的那块看到异色
    expect(tokenValue(darkDeclarations, '--color-surface').toLowerCase()).toBe('#18181b')
    expect(tokenValue(lightDeclarations, '--color-surface').toLowerCase()).toBe('#ffffff')
  })

  it('源码里没有原始色阶', () => {
    const offenders = sources.flatMap((file) => {
      const source = stripComments(read(file))
      return [...source.matchAll(RAW_PALETTE)].map((match) => `${file}: ${match[0]}`)
    })

    expect(offenders).toEqual([])
  })

  it('颜色类都落在已声明的 token 上', () => {
    const unknown = new Map<string, Set<string>>()

    for (const file of sources) {
      const source = stripComments(read(file))
      for (const match of source.matchAll(COLOR_UTILITY)) {
        const name = match.groups?.name ?? ''
        if (tokenKeys.has(name) || NON_COLOR_NAMES.has(name)) continue
        const key = `${match.groups?.util}-${name}`
        const files = unknown.get(key) ?? new Set<string>()
        files.add(file)
        unknown.set(key, files)
      }
    }

    expect(
      [...unknown].map(([name, files]) => `${name} (${[...files].sort().join(', ')})`)
    ).toEqual([])
  })

  it('浅色主题只有 token 覆盖，没有第二条选择器规则', () => {
    // 一个规则块 = 一份 token 表。出现第二个块就意味着又开始了"逐条翻译"
    expect(lightCss.match(/\{/g)?.length ?? 0).toBe(1)
    expect(lightCss).not.toMatch(/\.theme-light\s+[.:#a-z]/)
    expect(lightCss).not.toMatch(/!important/)
  })
})
