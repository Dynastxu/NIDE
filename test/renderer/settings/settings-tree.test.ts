import { describe, expect, it } from 'vitest'
import { buildSettingsTree } from '@renderer/settings/pages'
import type { PluginSettingsDescriptor } from '@shared/plugin-api'
import type { Translator } from '@shared/i18n'

/** 测试只关心“label 有没有被解析”，不关心具体词条内容 */
const t = ((key: string) => `label:${key}`) as unknown as Translator

function descriptor(overrides: Partial<PluginSettingsDescriptor> = {}): PluginSettingsDescriptor {
  return {
    id: 'ai-provider.providers',
    pluginId: 'builtin.ai-provider',
    title: 'AI 供应商',
    dir: 'ai-provider',
    entry: 'src/settings/index.tsx',
    order: 10,
    ...overrides
  }
}

describe('buildSettingsTree', () => {
  it('没有插件设置时保持原来的三棵顶层树，plugins 是叶子页', () => {
    const tree = buildSettingsTree(t, [])

    expect(tree.map((node) => node.id)).toEqual(['general', 'appearance-behavior', 'plugins'])

    const plugins = tree.find((node) => node.id === 'plugins')
    expect(plugins?.label).toBe('label:host.settings.page.plugins')
    expect(plugins?.page).toEqual({ kind: 'host', id: 'plugins' })
    expect(plugins?.children).toBeUndefined()
  })

  it('把插件设置挂到 plugins 节点下，并带上 plugin 页面引用', () => {
    const settings = descriptor()
    const tree = buildSettingsTree(t, [settings])
    const plugins = tree.find((node) => node.id === 'plugins')

    expect(plugins?.children).toHaveLength(1)
    expect(plugins?.children?.[0]).toMatchObject({
      id: 'plugin:builtin.ai-provider:ai-provider.providers',
      label: 'AI 供应商',
      page: { kind: 'plugin', descriptor: settings }
    })
  })

  it('多个插件设置保持主进程给的顺序，id 不冲突', () => {
    const tree = buildSettingsTree(t, [
      descriptor({ id: 'b', title: 'B' }),
      descriptor({ id: 'c', title: 'C', pluginId: 'builtin.other', dir: 'other' })
    ])

    const children = tree.find((node) => node.id === 'plugins')?.children ?? []
    expect(children.map((node) => node.label)).toEqual(['B', 'C'])
    expect(new Set(children.map((node) => node.id)).size).toBe(2)
  })

  it('两次构建互不影响，不会把上一次的插件节点留在宿主树上', () => {
    const first = buildSettingsTree(t, [descriptor()])
    const second = buildSettingsTree(t, [])

    expect(first.find((node) => node.id === 'plugins')?.children).toHaveLength(1)
    expect(second.find((node) => node.id === 'plugins')?.children).toBeUndefined()
  })
})
