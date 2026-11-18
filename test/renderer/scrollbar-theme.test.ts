import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 滚动条主题的护栏（issue #3）。
 *
 * 滚动条的正确性现在由**一条全局规则**承担：`scrollbar-color` / `scrollbar-width`
 * 写在 `:root` 上（两者都可继承），深浅两套主题只换 token。新增滚动容器不需要记得
 * 加任何类 —— 这正是以前 `.nide-scrollbar` 那个可选类的失败模式：忘加一次就退回
 * Chromium 的浅色原生滚动条，而它只在内容溢出时出现，截图与短内容自测都看不到。
 *
 * 所以这条用例守的不是「每个容器都调用了组件」，而是更根本的两件事：
 *
 * 1. **默认值放对方向**：全局规则还在、颜色只来自 token（写死色值等于浅色主题下
 *    又变深色），并且 `.native-scrollbar` 是显式退出而不是默认行为；
 * 2. **不许退回去**：调用点不得重新逐容器声明滚动条样式（旧的 `nide-scrollbar`、
 *    `::-webkit-scrollbar`、内联/任意值 `scrollbar-color` 都算）。确实需要原生
 *    滚动条的容器必须登记进 `NATIVE_SCROLLBAR_EXEMPTIONS` —— 那就是「显式豁免」，
 *    没登记 CI 就失败。
 *
 * 为什么不用 ESLint：仓库里已经有「靠源码约定失败」的 vitest 用例（见
 * `plugin-ui-glob.test.ts`、`client-roster.test.ts`），把护栏放在同一处比引入一条
 * 只在这里用得上的自定义 lint 规则更容易被读懂和维护。
 */

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

const INDEX_CSS = 'apps/desktop/renderer/src/assets/index.css'
const LIGHT_CSS = 'apps/desktop/renderer/src/assets/light.css'

/**
 * 需要**原生**滚动条的容器（相对仓库根）。
 *
 * 目前没有：Monaco 的滚动条是自绘 DOM 滑块，不经过原生滚动条，所以不需要豁免。
 * 以后真出现（例如嵌进来的第三方视图要交还给系统画），在这里登记并在调用点加
 * `native-scrollbar`，让"退出统一规则"这件事在 review 里可见。
 */
const NATIVE_SCROLLBAR_EXEMPTIONS: readonly string[] = []

const TSX_GLOBS = ['apps/**/*.tsx', 'packages/**/*.tsx'] as const
const IGNORED_DIRS = ['node_modules', 'dist', 'out', '.nide-dev', '.nide-dist']

function read(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), 'utf-8')
}

/** 取 `selector { ... }` 的声明体：这两个规则块里没有嵌套的大括号，正则够用。 */
function ruleBody(css: string, selectorPattern: string): string {
  const match = css.match(new RegExp(`${selectorPattern}\\s*\\{([^}]*)\\}`))
  if (!match) throw new Error(`在 ${selectorPattern} 上找不到规则块`)
  return match[1]
}

function tokenValue(declarations: string, token: string): string {
  const match = declarations.match(new RegExp(`${token}\\s*:\\s*([^;]+);`))
  if (!match) throw new Error(`找不到 token ${token}`)
  return match[1].trim()
}

/**
 * 去掉注释后再检查：注释里解释"为什么不再写 `::-webkit-scrollbar`"是正常的，
 * 不能因为它出现这几个字就让护栏失败。CSS 用块注释；TSX 两种都去。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function tsxSources(): string[] {
  return TSX_GLOBS.flatMap((glob) => fs.globSync(glob, { cwd: repoRoot }))
    .map((file) => file.split(path.sep).join('/'))
    .filter((file) => !IGNORED_DIRS.some((dir) => file.split('/').includes(dir)))
    .sort()
}

const indexCss = stripComments(read(INDEX_CSS))
const lightCss = stripComments(read(LIGHT_CSS))
const rootDeclarations = ruleBody(indexCss, ':root')
const lightDeclarations = ruleBody(lightCss, ':root\\.theme-light')
const nativeDeclarations = ruleBody(indexCss, '\\.native-scrollbar')
const sources = tsxSources()

describe('滚动条主题', () => {
  it('全局规则挂在 :root 上，颜色只来自 token', () => {
    expect(rootDeclarations).toMatch(/scrollbar-width:\s*thin/)
    expect(rootDeclarations).toMatch(
      /scrollbar-color:\s*var\(--nide-scrollbar-thumb\)\s+var\(--nide-scrollbar-track\)/
    )
    expect(tokenValue(rootDeclarations, '--nide-scrollbar-thumb')).not.toBe('')
    expect(tokenValue(rootDeclarations, '--nide-scrollbar-track')).not.toBe('')
  })

  it('浅色主题换掉滑块颜色，轨道保持透明', () => {
    const darkThumb = tokenValue(rootDeclarations, '--nide-scrollbar-thumb')
    const lightThumb = tokenValue(lightDeclarations, '--nide-scrollbar-thumb')

    // 两边取值不同，才说明浅色下真的翻过去了（相同就等于漏改）
    expect(lightThumb).not.toBe(darkThumb)
    expect(lightThumb).not.toBe('')
    expect(tokenValue(lightDeclarations, '--nide-scrollbar-track')).toBe('transparent')
  })

  it('原生滚动条是显式退出，默认不提供逐容器开关', () => {
    expect(nativeDeclarations).toMatch(/scrollbar-width:\s*auto/)
    expect(nativeDeclarations).toMatch(/scrollbar-color:\s*auto/)

    // `::-webkit-scrollbar` 在设置了标准属性之后会被 Chromium 忽略，留着就是死代码
    expect(indexCss).not.toContain('::-webkit-scrollbar')
    expect(lightCss).not.toContain('::-webkit-scrollbar')
    expect(indexCss).not.toMatch(/\.nide-scrollbar\s*(\{|::)/)
  })

  it('调用点没有重新逐容器声明滚动条样式', () => {
    const offenders = sources.filter((file) => {
      const source = stripComments(read(file))
      return (
        /nide-scrollbar/.test(source) ||
        /::-webkit-scrollbar/.test(source) ||
        /scrollbar-(color|width)\s*:/.test(source) ||
        /scrollbar(Color|Width)\s*:/.test(source)
      )
    })

    expect(offenders).toEqual([])
  })

  it('需要原生滚动条的容器都登记在豁免表里', () => {
    const usingNative = sources.filter((file) =>
      stripComments(read(file)).includes('native-scrollbar')
    )

    expect(usingNative).toEqual([...NATIVE_SCROLLBAR_EXEMPTIONS].sort())
    for (const file of NATIVE_SCROLLBAR_EXEMPTIONS) {
      const exists = fs.existsSync(path.join(repoRoot, file))
      expect(exists, `${file} 在豁免表里，但文件不存在`).toBe(true)
    }
  })
})
