import { describe, expect, it } from 'vitest'
import {
  DEFAULT_GALLERY_FIELDS,
  DEFAULT_GALLERY_REGISTRY,
  GALLERY_CATEGORY,
  composeGalleryEntry,
  formatGalleryEntry,
  galleryEntryFields,
  galleryEntryFileName,
  galleryEntryLabel,
  isGalleryConfigFileName,
  isGalleryEntryDocument,
  isGalleryEntryPath,
  normalizeGalleryName,
  parseGalleryConfig,
  parseGalleryRegistry,
  readGalleryEntry,
  serializeGalleryConfig,
  serializeGalleryRegistry,
  validateGalleryField
} from '@shared/project'

/**
 * 图鉴的纯逻辑：字段表（`config.yml`）、条目（整份 yml）、以及 `.nide` 里的注册表。
 *
 * 这一层不碰盘，是主进程与渲染进程共用的**唯一**一份判据 —— 界面按它决定给不给表单、
 * 主进程按它落盘。所以用例重点撞这几处：写出去的读得回来（包括换行与引号）、
 * **读不出来的形状要判为读不出来**（判宽了表单就会改掉一份别人的文件）、以及
 * 字段名与解析规则的一致性（一个存得进去却读不回来的字段名是最难查的那种）。
 */

/** 一份写出来的字段表读回来仍是同一份 */
function configRoundTrip(fields: string[]): string[] | null {
  const parsed = parseGalleryConfig(serializeGalleryConfig({ fields }))
  return parsed === null ? null : parsed.fields
}

/** 一组字段值写出去再读回来 */
function entryRoundTrip(values: Record<string, string>): Record<string, string> {
  return readGalleryEntry(formatGalleryEntry(values)).values
}

describe('字段表（config.yml）', () => {
  it('写出来的是「一个字段一行」，读回来是同一个列表', () => {
    expect(configRoundTrip(['名称', '外貌'])).toEqual(['名称', '外貌'])
  })

  it('一个字段都没有也是合法的：那是「还没定义字段」的图鉴', () => {
    expect(configRoundTrip([])).toEqual([])
    expect(parseGalleryConfig('fields:\n')).toEqual({ fields: [] })
  })

  it('注释与空行照常跳过（配置文件是人手改得动的）', () => {
    const text = ['# 我自己的注释', 'fields:', '  # 顺序就是表单里的顺序', '  - 名称', ''].join(
      '\n'
    )

    expect(parseGalleryConfig(text)).toEqual({ fields: ['名称'] })
  })

  it('单个标量的写法也收：手写一份只有一个字段的配置是常事', () => {
    expect(parseGalleryConfig('fields: 名称\n')).toEqual({ fields: ['名称'] })
  })

  it('没有 fields 键的 yml 不是图鉴配置', () => {
    expect(parseGalleryConfig('name: 角色\n')).toBeNull()
    expect(parseGalleryConfig('')).toBeNull()
  })

  it('多出别的顶层键就整份判为读不出来', () => {
    /**
     * 这一条是为了**不改错文件**：表单会按字段表重写整份 `config.yml`，所以一份不只是
     * 字段表的配置（别人家的 config.yml）不该被认成图鉴配置。
     */
    expect(parseGalleryConfig('fields:\n  - 名称\ntitle: 角色\n')).toBeNull()
  })

  it('fields 底下是嵌套映射时判为读不出来', () => {
    expect(parseGalleryConfig('fields:\n  名称:\n    alias: 主角\n')).toBeNull()
  })

  it('config.yml 与 config.yaml 都认，别的名字不认', () => {
    expect(isGalleryConfigFileName('D:\\Novel\\gallery\\角色\\config.yml')).toBe(true)
    expect(isGalleryConfigFileName('config.yaml')).toBe(true)
    expect(isGalleryConfigFileName('D:\\Novel\\gallery\\角色\\主角.yml')).toBe(false)
  })
})

describe('字段名的校验', () => {
  it('空、带空白、带冒号或 # 的名字都拒（它们在 `键: 值` 里读不回来）', () => {
    expect(validateGalleryField('')).toEqual({ ok: false, reason: 'empty' })
    expect(validateGalleryField('   ')).toEqual({ ok: false, reason: 'empty' })
    expect(validateGalleryField('出场 角色')).toEqual({ ok: false, reason: 'illegal-character' })
    expect(validateGalleryField('名称: 别名')).toEqual({ ok: false, reason: 'illegal-character' })
    expect(validateGalleryField('名称#1')).toEqual({ ok: false, reason: 'illegal-character' })
    expect(validateGalleryField('-名称')).toEqual({ ok: false, reason: 'illegal-character' })
  })

  it('首尾空白会被去掉：用户多敲的空格不该变成字段名的一部分', () => {
    expect(validateGalleryField('  名称  ')).toEqual({ ok: true, name: '名称' })
  })

  it('重名指的是**别的**字段里已经有这个名字', () => {
    expect(validateGalleryField('名称', ['名称', '外貌'])).toEqual({
      ok: false,
      reason: 'duplicate'
    })
    expect(validateGalleryField('年龄', ['名称', '外貌'])).toEqual({ ok: true, name: '年龄' })
  })

  it('过长的名字拒掉（按字符算，中日文不该被字节数坑到）', () => {
    expect(validateGalleryField('名'.repeat(65))).toEqual({ ok: false, reason: 'too-long' })
    expect(validateGalleryField('名'.repeat(64))).toEqual({ ok: true, name: '名'.repeat(64) })
  })

  it('通过校验的名字一定读得回来', () => {
    for (const name of ['名称', '外貌', '别名', '年龄', '登场章节']) {
      const validation = validateGalleryField(name)
      expect(validation.ok).toBe(true)

      const values = { [name]: '值' }
      expect(entryRoundTrip(values)).toEqual(values)
    }
  })
})

describe('条目（整份 yml）', () => {
  it('读得出类别与 data 底下那几个字段', () => {
    const text = ['category: gallery', 'data:', '  名称: 主角', '  外貌: 黑发'].join('\n')
    const entry = readGalleryEntry(text)

    expect(entry.category).toBe(GALLERY_CATEGORY)
    expect(entry.values).toEqual({ 名称: '主角', 外貌: '黑发' })
    expect(isGalleryEntryDocument(entry)).toBe(true)
  })

  it('手写的扁平条目也读得出来（没有 data 那一层）', () => {
    const entry = readGalleryEntry('category: gallery\n名称: 主角\n外貌: 黑发\n')

    expect(entry.values).toEqual({ 名称: '主角', 外貌: '黑发' })
  })

  it('手写的列表读成按行接起来的文本，内容不丢', () => {
    const text = ['category: gallery', 'data:', '  别名:', '    - 小主', '    - 阿主'].join('\n')

    expect(readGalleryEntry(text).values).toEqual({ 别名: '小主\n阿主' })
  })

  it('写出去的值一律加引号，值里的引号、冒号与换行都读得回来', () => {
    const values = {
      名称: '主角',
      简介: 'a: b "c" \\d',
      备注: '第一行\n第二行'
    }

    expect(entryRoundTrip(values)).toEqual(values)
  })

  it('空值不写出来：那不等于「这里就是空的」', () => {
    const text = formatGalleryEntry({ 名称: '主角', 外貌: '' }, ['名称', '外貌'])

    expect(text).not.toContain('外貌')
    expect(readGalleryEntry(text).values).toEqual({ 名称: '主角' })
  })

  it('写出去的顺序就是传进来的顺序；没列在里面的键跟在后面', () => {
    const text = formatGalleryEntry({ 名称: '主角', 旧字段: 'x' }, ['名称', '外貌'])

    expect(text.indexOf('名称')).toBeLessThan(text.indexOf('旧字段'))
    // 顺序表里的字段即使是空的也占位（不写出来），而文件里多出来的键必须保留
    expect(readGalleryEntry(text).values).toEqual({ 名称: '主角', 旧字段: 'x' })
  })

  it('新建条目的骨架带着类别，读出来就是图鉴条目', () => {
    const entry = readGalleryEntry(composeGalleryEntry())

    expect(isGalleryEntryDocument(entry)).toBe(true)
    expect(entry.values).toEqual({})
  })

  it('没有类别的 yml 不是图鉴条目', () => {
    expect(isGalleryEntryDocument(readGalleryEntry('名称: 主角\n'))).toBe(false)
  })

  it('只认 yml 与 yaml 两种扩展名', () => {
    expect(isGalleryEntryPath('D:\\Novel\\gallery\\角色\\主角.yml')).toBe(true)
    expect(isGalleryEntryPath('D:\\Novel\\gallery\\角色\\主角.yaml')).toBe(true)
    expect(isGalleryEntryPath('D:\\Novel\\gallery\\角色\\主角.md')).toBe(false)
  })
})

describe('条目的显示名与文件名', () => {
  it('第一个字段的值就是条目的名字', () => {
    expect(galleryEntryLabel({ 名称: '主角', 外貌: '黑发' }, ['名称', '外貌'], 'a.yml')).toBe(
      '主角'
    )
  })

  it('取不到名字时回落到文件名（去掉扩展名）', () => {
    expect(galleryEntryLabel({}, ['名称', '外貌'], '主角.yml')).toBe('主角')
    expect(galleryEntryLabel({ 名称: '  ' }, ['名称'], '主角.yml')).toBe('主角')
    expect(galleryEntryLabel({}, [], '主角.yaml')).toBe('主角')
  })

  it('没有扩展名时补 .yml；已经有 yml / yaml 就照原样', () => {
    expect(galleryEntryFileName('主角')).toBe('主角.yml')
    expect(galleryEntryFileName('主角.yml')).toBe('主角.yml')
    expect(galleryEntryFileName('主角.yaml')).toBe('主角.yaml')
    expect(galleryEntryFileName('  主角  ')).toBe('主角.yml')
  })

  it('别的扩展名不替换，而是在后面补一个 .yml（补出来的名字会显示给用户）', () => {
    expect(galleryEntryFileName('主角.md')).toBe('主角.md.yml')
  })
})

describe('要编辑的字段与文件里多出来的键', () => {
  it('配置里的字段按顺序在前，文件里多出来的跟在后面', () => {
    expect(galleryEntryFields({ 旧字段: 'x', 名称: '主角' }, ['名称', '外貌'])).toEqual([
      '名称',
      '外貌',
      '旧字段'
    ])
  })

  it('空名字与重名跳过：配置里那个空名字是「用户正在敲」', () => {
    expect(galleryEntryFields({ 名称: '主角' }, ['名称', '', '  ', '名称'])).toEqual(['名称'])
  })

  it('还没有字段表时按文件自己的键来', () => {
    expect(galleryEntryFields({ 名称: '主角', 外貌: '黑发' }, [])).toEqual(['名称', '外貌'])
  })
})

describe('注册表（.nide/gallery.yml）', () => {
  it('写出来读回来还是同一份', () => {
    expect(parseGalleryRegistry(serializeGalleryRegistry({ characters: 'characters' }))).toEqual({
      characters: 'characters'
    })
    expect(parseGalleryRegistry(serializeGalleryRegistry({ characters: '人物' }))).toEqual({
      characters: '人物'
    })
  })

  it('默认注册表指向默认的角色图鉴目录', () => {
    expect(DEFAULT_GALLERY_REGISTRY).toEqual({ characters: 'characters' })
  })

  it('缺键、值不是字符串、或者值是多段路径时判为坏文件', () => {
    expect(parseGalleryRegistry('')).toBeNull()
    expect(parseGalleryRegistry('# 只有注释\n')).toBeNull()
    expect(parseGalleryRegistry('characters: 12\n')).toBeNull()
    expect(parseGalleryRegistry('characters: 卷一/角色\n')).toBeNull()
    expect(parseGalleryRegistry('characters: ../外面\n')).toBeNull()
  })

  it('图鉴名只有一段：绝对路径与 .. 都过不去', () => {
    expect(normalizeGalleryName('characters')).toBe('characters')
    expect(normalizeGalleryName(' 人物 ')).toBe('人物')
    expect(normalizeGalleryName('')).toBeNull()
    expect(normalizeGalleryName('卷一/角色')).toBeNull()
    expect(normalizeGalleryName('D:\\Novel\\gallery')).toBeNull()
    expect(normalizeGalleryName('..')).toBeNull()
  })
})

describe('默认字段', () => {
  it('新建图鉴的默认字段里有「名称」：没有它，列表连显示什么都答不出来', () => {
    expect(DEFAULT_GALLERY_FIELDS[0]).toBe('名称')
  })
})
