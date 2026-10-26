import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 插件 UI 的 `import.meta.glob` 路径。
 *
 * 两个 slot 用「相对本文件的 glob」把内置插件的视图 / 设置页打进 bundle。这种写法
 * 有两个只在运行时才暴露的失败模式：
 *
 * 1. **层数写错** → glob 展开成空表。Vite 不报错，界面上只显示「找不到 UI 模块」
 *    （真发生过：设置页搬进 `client-ui-settings` 后少算了一层）；
 * 2. **目录写错** → 表里有别的 key，同样命不中。
 *
 * 被测文件**靠发现**而不是硬编码：以前这里写死了两个路径，结果视图管线从
 * `client-kit` 搬到 `sdk` 时用例自己先炸了（`ENOENT`）—— 那是「测试跟不上搬家」，
 * 不是被测代码坏了。现在按命名约定找 `packages/*\/src/**\/Plugin*Slot.tsx`：
 * 文件搬到哪个包都行，只要还叫这个名。
 *
 * 约定本身也断言了：至少要找到两个（视图 + 设置页），少了说明命名变了，这条用例
 * 就失效了 —— 那比「静默通过」好。
 */
const repoRoot = path.resolve(import.meta.dirname, '..', '..')

/** 两个 slot 的命名约定：`PluginSlot`（视图）与 `PluginSettingsSlot`（设置页） */
const SOURCE_GLOB = 'packages/*/src/**/Plugin*Slot.tsx'

function findSlotSources(): string[] {
  return fs
    .globSync(SOURCE_GLOB, { cwd: repoRoot })
    .map((file) => file.split(path.sep).join('/'))
    .sort()
}

function patternOf(file: string): string {
  const source = fs.readFileSync(path.join(repoRoot, file), 'utf-8')
  const match = source.match(/import\.meta\.glob\(\s*'([^']+)'/)
  if (!match) throw new Error(`no import.meta.glob pattern in ${file}`)
  return match[1]
}

const slotSources = findSlotSources()

describe('插件 UI 的 glob 路径', () => {
  it(`按约定找到两个 slot 源文件（${SOURCE_GLOB}）`, () => {
    expect(slotSources).toHaveLength(2)
    expect(slotSources.some((file) => file.endsWith('/PluginSlot.tsx'))).toBe(true)
    expect(slotSources.some((file) => file.endsWith('/PluginSettingsSlot.tsx'))).toBe(true)
  })

  for (const file of slotSources) {
    const pattern = patternOf(file)
    // `<repo>/plugins/builtin/*/<mid...>/<file>.tsx`
    const resolved = path.resolve(path.dirname(path.join(repoRoot, file)), pattern)
    const firstStar = resolved.indexOf('*')

    it(`${file} 的 glob 落在 plugins/builtin 下`, () => {
      expect(firstStar).toBeGreaterThan(-1)

      const head = path.normalize(resolved.slice(0, firstStar))
      expect(head).toBe(path.join(repoRoot, 'plugins', 'builtin') + path.sep)
    })

    it(`${file} 的 glob 至少匹配到一个真实入口`, () => {
      const head = resolved.slice(0, firstStar)
      // `/<插件目录>/src/ui/<文件名>.tsx`：`*` 之前的固定层是相对插件目录的路径
      const tail = resolved.slice(firstStar + 1)
      const beforeName = tail.slice(0, tail.lastIndexOf('*'))
      const dirs = beforeName.split('/').filter(Boolean)
      const ext = path.extname(resolved)

      expect(ext).toBe('.tsx')
      expect(fs.existsSync(head)).toBe(true)

      const matches = fs
        .readdirSync(head, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
          const dir = path.join(head, entry.name, ...dirs)
          if (!fs.existsSync(dir)) return []
          return fs
            .readdirSync(dir)
            .filter((name) => name.endsWith(ext))
            .map((name) => path.join(dir, name))
        })

      expect(matches.length).toBeGreaterThan(0)
    })
  }
})
