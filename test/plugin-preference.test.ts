import { describe, expect, it } from 'vitest'
import {
  PLUGIN_PREFERENCE_VERSION,
  emptyPluginPreference,
  isPluginEnabled,
  normalizePluginId,
  parsePluginPreference,
  setPluginEnabled
} from '@shared/plugin-api'
import type { PluginPreference } from '@shared/plugin-api'

/**
 * 插件启用状态这份数据的纯逻辑。
 *
 * 覆盖的都是**会静默出错**的地方：坏文件（用户以为禁用生效了、其实全部启用）、
 * 版本不认识（按猜测的语义解释会把插件禁用到用户没打算禁的地方）、脏 id
 * （永远匹配不上插件却一直留在文件里）、以及无变化时的重复落盘。
 * 落盘本身依赖 electron 的 userData 路径，不在这里 —— 那部分要手动跑应用验证。
 */

function preferenceWith(...disabled: string[]): PluginPreference {
  return { version: PLUGIN_PREFERENCE_VERSION, disabled }
}

describe('normalizePluginId', () => {
  it('去掉首尾空白', () => {
    expect(normalizePluginId('  builtin.demo  ')).toBe('builtin.demo')
  })

  it('非字符串与空串一律收敛成空串，调用方据此判断「这个 id 不能用」', () => {
    for (const raw of [null, undefined, 42, {}, [], '   ']) {
      expect(normalizePluginId(raw)).toBe('')
    }
  })
})

describe('isPluginEnabled', () => {
  it('没有记录的插件视为启用', () => {
    expect(isPluginEnabled(emptyPluginPreference(), 'builtin.demo')).toBe(true)
  })

  it('判定前先收敛 id，带空白的写法与干净写法得到同一个结论', () => {
    expect(isPluginEnabled(preferenceWith('builtin.demo'), ' builtin.demo ')).toBe(false)
  })

  it('id 收敛后是空串时视为启用，不把一个匹配不上任何插件的值当成命中', () => {
    expect(isPluginEnabled(preferenceWith(''), '')).toBe(true)
  })
})

describe('parsePluginPreference', () => {
  it('坏输入一律回落成空偏好，不抛异常', () => {
    for (const raw of [null, undefined, 42, 'nope', []]) {
      expect(parsePluginPreference(raw)).toEqual(emptyPluginPreference())
    }
  })

  it('版本对不上就整体回落：宁可回到全部启用，也不按猜测的语义解释数据', () => {
    const raw = {
      version: PLUGIN_PREFERENCE_VERSION + 1,
      disabled: ['builtin.demo']
    }
    expect(parsePluginPreference(raw)).toEqual(emptyPluginPreference())
  })

  it('丢掉坏 id，但保留同一份文件里有效的禁用记录', () => {
    const preference = parsePluginPreference({
      version: PLUGIN_PREFERENCE_VERSION,
      disabled: ['builtin.demo', '', '   ', null, 42, { id: 'x' }, 'builtin.lang-en']
    })

    expect(preference.disabled).toEqual(['builtin.demo', 'builtin.lang-en'])
  })

  it('去重并排序，让磁盘上的内容有确定的顺序', () => {
    const preference = parsePluginPreference({
      version: PLUGIN_PREFERENCE_VERSION,
      disabled: ['builtin.z', 'builtin.a', 'builtin.z', ' builtin.a ']
    })

    expect(preference.disabled).toEqual(['builtin.a', 'builtin.z'])
  })

  it('disabled 字段缺失或不是数组时按空集合处理，而不是整份文件作废', () => {
    expect(parsePluginPreference({ version: PLUGIN_PREFERENCE_VERSION })).toEqual(
      emptyPluginPreference()
    )
    expect(
      parsePluginPreference({ version: PLUGIN_PREFERENCE_VERSION, disabled: 'builtin.demo' })
    ).toEqual(emptyPluginPreference())
  })
})

describe('setPluginEnabled', () => {
  it('禁用把 id 加进集合，启用把它移出去', () => {
    let preference = emptyPluginPreference()

    preference = setPluginEnabled(preference, 'builtin.demo', false)
    expect(preference.disabled).toEqual(['builtin.demo'])
    expect(isPluginEnabled(preference, 'builtin.demo')).toBe(false)

    preference = setPluginEnabled(preference, 'builtin.demo', true)
    expect(preference.disabled).toEqual([])
    expect(isPluginEnabled(preference, 'builtin.demo')).toBe(true)
  })

  it('写入前收敛 id，带空白的写法不会在文件里留下第二条记录', () => {
    const preference = setPluginEnabled(emptyPluginPreference(), '  builtin.demo  ', false)

    expect(preference.disabled).toEqual(['builtin.demo'])
  })

  it('值没有实际变化时返回同一个引用，调用方据此跳过落盘', () => {
    const disabled = preferenceWith('builtin.demo')
    expect(setPluginEnabled(disabled, 'builtin.demo', false)).toBe(disabled)

    const enabled = emptyPluginPreference()
    expect(setPluginEnabled(enabled, 'builtin.demo', true)).toBe(enabled)
  })

  it('收敛后是空串的 id 原样返回，不接受一次会写坏文件的改动', () => {
    const preference = emptyPluginPreference()

    expect(setPluginEnabled(preference, '   ', false)).toBe(preference)
    expect(setPluginEnabled(preference, '', false)).toBe(preference)
  })
})
