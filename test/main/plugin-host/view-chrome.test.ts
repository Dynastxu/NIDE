import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginLoader, setPluginHostLogger } from '../../../src/main/plugin-host/loader'
import { uiRegistry } from '../../../src/main/plugin-host/ui-registry'
import { manifestNlsRegistry } from '../../../src/main/i18n/manifest-nls'
import { createPluginFixture, type PluginFixture } from '../../fixtures/plugin-fixture'
import type { Logger } from '@shared/logger'

/**
 * 视图外壳（`contributes.views[].chrome`）从 manifest 到视图表的这一路。
 *
 * manifest 是插件作者手写的 JSON，而 chrome 里的每一项都直接决定界面上画不画标题栏、
 * 最小化按钮与「更多」按钮。所以这里测的是**收敛规则**：写坏的那一项被丢掉、其余照常
 * 生效，并且留下一句告警 —— 而不是整份声明作废，也不是让 `"false"` 这种字符串当真值
 * 传下去（那会多出一个作者明确想关掉的按钮）。
 */
function spyLogger(): Logger & { calls: Array<[string, string, unknown]> } {
  const calls: Array<[string, string, unknown]> = []
  const record =
    (level: string) =>
    (text: string, fields?: Record<string, unknown>): void => {
      calls.push([level, text, fields])
    }

  return {
    calls,
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    dispatch: (level, text, fields) => calls.push([level, text, fields])
  }
}

/** 一个只贡献单个视图的 manifest，chrome 由调用方给 */
function viewManifest(chrome: unknown): unknown {
  return {
    id: 'builtin.chrome-test',
    name: 'chrome test',
    version: '1.0.0',
    contributes: {
      views: [
        {
          id: 'chrome.view',
          title: '外壳测试',
          location: 'rightTop',
          entry: 'src/ui/index.tsx',
          chrome
        }
      ]
    }
  }
}

describe('视图外壳声明', () => {
  let fixture: PluginFixture
  let loader: PluginLoader
  let logger: ReturnType<typeof spyLogger>

  beforeEach(() => {
    fixture = createPluginFixture()
    loader = new PluginLoader()
    manifestNlsRegistry.reset()
    uiRegistry.reset()

    logger = spyLogger()
    setPluginHostLogger(logger)
  })

  afterEach(() => {
    fixture.remove()
    manifestNlsRegistry.reset()
    uiRegistry.reset()
    vi.restoreAllMocks()
  })

  it('没有声明 chrome 时不落任何字段，由渲染进程用默认值（全开）', () => {
    const manifestPath = fixture.plugin('no-chrome', viewManifest(undefined))

    loader.loadContributions(manifestPath, 'builtin')

    expect(uiRegistry.get('chrome.view')?.chrome).toBeUndefined()
  })

  it('合法声明原样落到视图表', () => {
    const manifestPath = fixture.plugin(
      'with-chrome',
      viewManifest({ title: false, minimize: false, tabs: true })
    )

    loader.loadContributions(manifestPath, 'builtin')

    expect(uiRegistry.get('chrome.view')?.chrome).toEqual({
      title: false,
      minimize: false,
      tabs: true
    })
  })

  it('非布尔值的那一项被丢掉，同一份声明里其余项照常生效', () => {
    const manifestPath = fixture.plugin(
      'bad-flag',
      viewManifest({ title: 'false', minimize: false })
    )

    loader.loadContributions(manifestPath, 'builtin')

    // 'false' 不是布尔，丢掉它 —— 视图因此拿到默认的 title: true
    expect(uiRegistry.get('chrome.view')?.chrome).toEqual({ minimize: false })
    expect(
      logger.calls.some(
        ([level, , fields]) =>
          level === 'warn' && (fields as { flag?: string } | undefined)?.flag === 'title'
      )
    ).toBe(true)
  })

  it('chrome 整个写成非对象时忽略它，视图照常注册', () => {
    const manifestPath = fixture.plugin('not-object', viewManifest('header'))

    loader.loadContributions(manifestPath, 'builtin')

    expect(uiRegistry.get('chrome.view')?.chrome).toBeUndefined()
    // 视图本身必须还在：外壳声明写坏不该让插件从工具区里消失
    expect(uiRegistry.get('chrome.view')?.titleSpec).toBe('外壳测试')
    expect(logger.calls.some(([level]) => level === 'warn')).toBe(true)
  })

  it('不认识的开关被静默忽略（只认那五个字段）', () => {
    const manifestPath = fixture.plugin(
      'unknown-flag',
      viewManifest({ minimize: false, ttile: true })
    )

    loader.loadContributions(manifestPath, 'builtin')

    expect(uiRegistry.get('chrome.view')?.chrome).toEqual({ minimize: false })
  })
})
