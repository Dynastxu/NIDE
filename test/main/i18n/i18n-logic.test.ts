import { describe, expect, it } from 'vitest'
import {
  createLooseTranslator,
  createTranslator,
  interpolate,
  localeCandidates,
  normalizeLocale,
  toMonacoLocale
} from '@nide/contracts/i18n'

/**
 * 共享层的 i18n 纯函数：locale 规范化 / 候选链 / Monaco 映射 / 插值 / `t()`。
 *
 * 语言包注册表与 manifest 文案解析已经搬到 host
 * （见 [test/host/i18n.test.ts](../host/i18n.test.ts)）—— 那边才是读插件目录、做
 * 逐 key 瀑布的地方；这里只剩「两个进程都会用到的那些函数」。
 */

describe('locale 规范化', () => {
  it('把下划线转成连字符并收敛大小写', () => {
    expect(normalizeLocale('zh_hans_cn')).toBe('zh-Hans-CN')
  })

  it('语言小写、地区大写', () => {
    expect(normalizeLocale('EN_us')).toBe('en-US')
  })

  it('空串回落到默认 locale', () => {
    expect(normalizeLocale('')).toBe('zh-CN')
  })
})

describe('locale 候选链', () => {
  it('由具体到宽泛', () => {
    expect(localeCandidates('zh-Hans-CN')).toEqual(['zh-Hans-CN', 'zh-Hans', 'zh'])
  })
})

describe('Monaco locale 映射', () => {
  // Monaco 的文件名是小写，项目内部是 BCP-47，这层映射是必要的翻译
  it('zh-CN 映射成 zh-cn', () => {
    expect(toMonacoLocale('zh-CN')).toBe('zh-cn')
  })

  it('zh-TW 映射成 zh-tw', () => {
    expect(toMonacoLocale('zh-TW')).toBe('zh-tw')
  })

  it('zh-Hant 走繁体', () => {
    expect(toMonacoLocale('zh-Hant')).toBe('zh-tw')
  })

  it('英文返回 null —— Monaco 的英文是内建默认，不存在语言文件', () => {
    expect(toMonacoLocale('en-US')).toBeNull()
  })

  it('不认识的语言返回 null', () => {
    expect(toMonacoLocale('xx-YY')).toBeNull()
  })
})

describe('插值', () => {
  it('按 {name} 替换', () => {
    expect(interpolate('已点击 {count} 次', { count: 3 })).toBe('已点击 3 次')
  })

  it('缺参数时保留占位符，便于一眼看出漏传', () => {
    expect(interpolate('{a}-{b}', { a: 1 })).toBe('1-{b}')
  })

  it('不传参数时原样返回', () => {
    expect(interpolate('原样')).toBe('原样')
  })
})

describe('宿主 t()', () => {
  it('词条表里没有时回落中文基础表', () => {
    expect(createTranslator({})('host.diff.close')).toBe('关闭')
  })

  it('只接受宿主命名空间的 key', () => {
    // 传 'k' 这类 key 会触发 TS2345 —— 那条类型约束就是宿主代码的安全网，
    // 这里只能断言运行时行为，编译期那半由 tsc 保证
    expect(createTranslator({ 'host.diff.close': 'Close' })('host.diff.close')).toBe('Close')
  })

  it('走的是同一套插值', () => {
    expect(createTranslator({ 'host.diff.close': '{a} 条' })('host.diff.close', { a: 7 })).toBe(
      '7 条'
    )
  })
})

describe('插件的 t()', () => {
  it('key 放宽成任意字符串', () => {
    expect(createLooseTranslator({ k: '已点击 {count} 次' })('k', { count: 2 })).toBe('已点击 2 次')
  })

  it('漏翻时原样给出 key，而不是回落到宿主中文', () => {
    // 回落成宿主中文只会掩盖"这个插件漏翻"，还会造成中英混排
    expect(createLooseTranslator({ k: 'x' })('missing')).toBe('missing')
  })
})
