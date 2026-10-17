import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROJECT_CONFIG,
  DEFAULT_PROJECT_META_IGNORE,
  PROJECT_CONFIG_CHANNELS,
  PROJECT_CONFIG_FILE_NAME,
  PROJECT_META_DIR_NAME,
  PROJECT_META_IGNORE_FILE_NAME,
  applyProjectConfigPatch,
  isIgnoredDirectoryName,
  isMetaDirectoryPath,
  isProjectConfigKey,
  normalizeConfigDirectory,
  normalizeDirectorySegment,
  parseLegacyGalleryRegistry,
  parseLegacyProjectConfig,
  parseProjectConfig,
  sanitizeProjectConfigPatch,
  serializeProjectConfig,
  validateProjectConfig
} from '@shared/project'

/**
 * 项目配置（`.nide/config.yml`）的**纯逻辑**：配置形状、路径校验、补丁应用、
 * 以及配置文本的读写。
 *
 * 覆盖两类会**静默出错**的地方：
 *
 * - 解析：把一份坏配置读成半份好配置（于是「配置说的目录」和界面以为的不是一回事）、
 *   把逃出项目根的路径收下（目录名是可以写进配置的，`..` 会建到项目外面去）；
 * - 补丁：一项不合格却让别的项生效（半生效的配置比整条拒绝更难查）。
 *
 * 合并之前那一版（扁平四项 + 单独的 `gallery.yml`）由 `parseLegacyProjectConfig` 与
 * `parseLegacyGalleryRegistry` 读出来；「把它们合成一份写回去」在
 * `src/main/services/project-config.service.ts`，它依赖 fs 与主进程日志，不在这里 ——
 * 清单见 [测试](Testing) 与 [项目与欢迎窗口](Projects) 的手工验证。
 */

describe('配置的形状', () => {
  it('四个分区就是配置项', () => {
    for (const key of ['chapters', 'gallery', 'foreshadowing', 'overview']) {
      expect(isProjectConfigKey(key)).toBe(true)
    }

    // 别的键不是配置项：`.nide` 将来会加东西，那些不该被当内容目录
    expect(isProjectConfigKey('chapter')).toBe(false)
    expect(isProjectConfigKey('chapters ')).toBe(false)
    expect(isProjectConfigKey('')).toBe(false)
  })

  it('默认值都是单段英文目录名，图鉴那一段还记着角色图鉴', () => {
    expect(DEFAULT_PROJECT_CONFIG).toEqual({
      chapters: { path: 'chapters' },
      gallery: { path: 'gallery', characters: 'characters' },
      foreshadowing: { path: 'foreshadowing' },
      overview: { path: 'overview' }
    })
  })

  it('落盘文件名固定，`config.yml` 与 `.nide/.gitignore` 都放在 `.nide` 下', () => {
    expect(PROJECT_META_DIR_NAME).toBe('.nide')
    expect(PROJECT_CONFIG_FILE_NAME).toBe('config.yml')
    expect(PROJECT_META_IGNORE_FILE_NAME).toBe('.gitignore')
    // 初始的忽略文件不忽略任何东西，只是一行说明
    expect(DEFAULT_PROJECT_META_IGNORE).toContain('Nothing is ignored yet.')
  })

  it('通道名带 host: 前缀', () => {
    expect(PROJECT_CONFIG_CHANNELS.read).toBe('host:project-read-config')
    expect(PROJECT_CONFIG_CHANNELS.update).toBe('host:project-update-config')
  })
})

describe('normalizeConfigDirectory', () => {
  it('去空白、按 / 分段', () => {
    expect(normalizeConfigDirectory('  chapters  ')).toBe('chapters')
    expect(normalizeConfigDirectory('chapters/volume-1')).toBe('chapters/volume-1')
    // Windows 上习惯写的反斜杠也当分隔符，并收敛成规范写法
    expect(normalizeConfigDirectory('chapters\\volume-1')).toBe('chapters/volume-1')
  })

  it('拒绝会跑到项目外面的路径', () => {
    expect(normalizeConfigDirectory('')).toBeNull()
    expect(normalizeConfigDirectory('   ')).toBeNull()
    expect(normalizeConfigDirectory('/etc')).toBeNull()
    expect(normalizeConfigDirectory('C:\\novel')).toBeNull()
    expect(normalizeConfigDirectory('..')).toBeNull()
    expect(normalizeConfigDirectory('../outside')).toBeNull()
    expect(normalizeConfigDirectory('chapters/../../outside')).toBeNull()
    // 空段落：路径不是规范写法，收下等于替用户猜
    expect(normalizeConfigDirectory('chapters//volume')).toBeNull()
    expect(normalizeConfigDirectory('chapters/')).toBeNull()
    expect(normalizeConfigDirectory('chapters/\0')).toBeNull()
  })

  it('以点开头的目录名是允许的（隐藏目录也是一种目录）', () => {
    expect(normalizeConfigDirectory('.drafts')).toBe('.drafts')
  })

  it('`.nide` 自己与它内部的东西判为元数据路径', () => {
    expect(isMetaDirectoryPath('.nide')).toBe(true)
    expect(isMetaDirectoryPath('.nide/cache')).toBe(true)
    expect(isMetaDirectoryPath('.nidex')).toBe(false)
    expect(isMetaDirectoryPath('chapters')).toBe(false)
  })
})

describe('normalizeDirectorySegment（图鉴名只有一段）', () => {
  it('单段目录名照收，多段与绝对路径都拒', () => {
    expect(normalizeDirectorySegment('characters')).toBe('characters')
    expect(normalizeDirectorySegment(' 人物 ')).toBe('人物')
    expect(normalizeDirectorySegment('')).toBeNull()
    expect(normalizeDirectorySegment('卷一/角色')).toBeNull()
    expect(normalizeDirectorySegment('D:\\Novel\\gallery')).toBeNull()
    expect(normalizeDirectorySegment('..')).toBeNull()
  })
})

describe('validateProjectConfig', () => {
  it('四个分区齐全且合法时通过', () => {
    const config = {
      chapters: { path: 'chapters' },
      gallery: { path: 'gallery', characters: 'characters' },
      foreshadowing: { path: 'foreshadowing' },
      overview: { path: 'overview' }
    }

    expect(validateProjectConfig(config)).toEqual(config)
  })

  it('缺一段、或一段里缺 path 就整份作废（不逐项回落）', () => {
    expect(
      validateProjectConfig({
        chapters: { path: 'chapters' },
        gallery: { path: 'gallery', characters: 'characters' },
        foreshadowing: { path: 'foreshadowing' }
      })
    ).toBeNull()

    expect(
      validateProjectConfig({
        chapters: {},
        gallery: { path: 'gallery', characters: 'characters' },
        foreshadowing: { path: 'foreshadowing' },
        overview: { path: 'overview' }
      })
    ).toBeNull()
  })

  it('一段写成了扁平字符串（合并之前那一版）就整份作废', () => {
    expect(
      validateProjectConfig({
        chapters: 'chapters',
        gallery: { path: 'gallery', characters: 'characters' },
        foreshadowing: { path: 'foreshadowing' },
        overview: { path: 'overview' }
      })
    ).toBeNull()
  })

  it('有一项非法就整份作废（含图鉴名是多段）', () => {
    expect(
      validateProjectConfig({
        chapters: { path: '../outside' },
        gallery: { path: 'gallery', characters: 'characters' },
        foreshadowing: { path: 'foreshadowing' },
        overview: { path: 'overview' }
      })
    ).toBeNull()

    expect(
      validateProjectConfig({
        chapters: { path: 'chapters' },
        gallery: { path: 'gallery', characters: '卷一/角色' },
        foreshadowing: { path: 'foreshadowing' },
        overview: { path: 'overview' }
      })
    ).toBeNull()

    expect(
      validateProjectConfig({
        chapters: { path: 'chapters' },
        gallery: { path: 'gallery' },
        foreshadowing: { path: 'foreshadowing' },
        overview: { path: 'overview' }
      })
    ).toBeNull()
  })

  it('非对象一律作废', () => {
    expect(validateProjectConfig(null)).toBeNull()
    expect(validateProjectConfig('chapters')).toBeNull()
    expect(validateProjectConfig([])).toBeNull()
  })
})

describe('sanitizeProjectConfigPatch', () => {
  it('只认已知的分区、分区里只认 path 与 characters、只认字符串值', () => {
    expect(
      sanitizeProjectConfigPatch({
        chapters: { path: 'manuscript', characters: 'x' },
        unknown: { path: 'x' },
        gallery: { path: 42, characters: '人物' },
        overview: null
      })
    ).toEqual({
      chapters: { path: 'manuscript' },
      gallery: { characters: '人物' }
    })
  })

  it('分区里没有可用字段时整段丢掉', () => {
    expect(sanitizeProjectConfigPatch({ chapters: {}, gallery: 'gallery' })).toEqual({})
  })

  it('非对象给空补丁', () => {
    expect(sanitizeProjectConfigPatch(null)).toEqual({})
    expect(sanitizeProjectConfigPatch('chapters')).toEqual({})
  })
})

describe('applyProjectConfigPatch', () => {
  it('全部合格时替换，未提到的分区保持原样', () => {
    const result = applyProjectConfigPatch(DEFAULT_PROJECT_CONFIG, {
      chapters: { path: 'manuscript' }
    })

    expect(result.ok).toBe(true)
    expect(result.config).toEqual({
      ...DEFAULT_PROJECT_CONFIG,
      chapters: { path: 'manuscript' }
    })
  })

  it('图鉴那一段的 characters 也能改', () => {
    const result = applyProjectConfigPatch(DEFAULT_PROJECT_CONFIG, {
      gallery: { characters: '人物' }
    })

    expect(result.ok).toBe(true)
    expect(result.config.gallery).toEqual({ path: 'gallery', characters: '人物' })
  })

  it('有一项不合格就一项都不改', () => {
    const result = applyProjectConfigPatch(DEFAULT_PROJECT_CONFIG, {
      chapters: { path: 'manuscript' },
      gallery: { path: '../outside' }
    })

    expect(result.ok).toBe(false)
    expect(result.rejected).toEqual(['gallery'])
    expect(result.config).toEqual(DEFAULT_PROJECT_CONFIG)
  })

  it('多段的角色图鉴名判为不合格', () => {
    const result = applyProjectConfigPatch(DEFAULT_PROJECT_CONFIG, {
      gallery: { characters: '卷一/角色' }
    })

    expect(result.ok).toBe(false)
    expect(result.rejected).toEqual(['gallery'])
    expect(result.config).toEqual(DEFAULT_PROJECT_CONFIG)
  })

  it('指向 `.nide` 内部的值判为冲突', () => {
    const result = applyProjectConfigPatch(DEFAULT_PROJECT_CONFIG, {
      overview: { path: '.nide/notes' }
    })

    expect(result.ok).toBe(false)
    expect(result.conflicts).toEqual(['overview'])
    expect(result.config).toEqual(DEFAULT_PROJECT_CONFIG)
  })
})

describe('config.yml 的文本', () => {
  it('写出来的形状稳定：注释头 + 四段，每段缩进两格', () => {
    expect(serializeProjectConfig(DEFAULT_PROJECT_CONFIG)).toBe(
      [
        '# NIDE project configuration',
        '# Paths are relative to the project root.',
        'chapters:',
        '  path: "chapters"',
        'gallery:',
        '  path: "gallery"',
        '  characters: "characters"',
        'foreshadowing:',
        '  path: "foreshadowing"',
        'overview:',
        '  path: "overview"',
        ''
      ].join('\n')
    )
  })

  it('读写一个来回不丢东西（含引号与角色图鉴名）', () => {
    const config = {
      chapters: { path: 'chapters/volume-1' },
      gallery: { path: 'a "quoted" name', characters: '人物' },
      foreshadowing: { path: 'foreshadowing' },
      overview: { path: 'overview' }
    }

    const text = serializeProjectConfig(config)
    // 值里的引号在写出来时必须被转义，否则读回来的是另一个值
    expect(text).toContain('  path: "a \\"quoted\\" name"')
    expect(parseProjectConfig(text)).toEqual(config)
  })

  it('反斜杠按分隔符收敛成 /（Windows 上习惯写的那种路径）', () => {
    const text = [
      'chapters:',
      '  path: chapters\\volume-1',
      'gallery:',
      '  path: gallery',
      '  characters: characters',
      'foreshadowing:',
      '  path: foreshadowing',
      'overview:',
      '  path: overview'
    ].join('\n')

    expect(parseProjectConfig(text)).toEqual({
      ...DEFAULT_PROJECT_CONFIG,
      chapters: { path: 'chapters/volume-1' }
    })
  })

  it('人手写的普通标量也认（不强制加引号）', () => {
    const text = [
      'chapters:',
      '    path: chapters',
      'gallery:',
      '    path: gallery',
      '    characters: 人物',
      'foreshadowing:',
      '    path: f',
      'overview:',
      '    path: o'
    ].join('\n')

    expect(parseProjectConfig(text)).toEqual({
      chapters: { path: 'chapters' },
      gallery: { path: 'gallery', characters: '人物' },
      foreshadowing: { path: 'f' },
      overview: { path: 'o' }
    })
  })

  it('未知的分区连同它缩进的子键一起被忽略，BOM 与 CRLF 都能读', () => {
    const text = [
      '\uFEFF# comment',
      'chapters:',
      '  path: "chapters"',
      'gallery:',
      '  path: "gallery"',
      '  characters: "characters"',
      'foreshadowing:',
      '  path: "foreshadowing"',
      'overview:',
      '  path: "overview"',
      'future-section:',
      '  path: "whatever"',
      '  characters: "whatever"',
      ''
    ].join('\r\n')

    expect(parseProjectConfig(text)).toEqual(DEFAULT_PROJECT_CONFIG)
  })

  it('坏掉的写法判为坏配置，而不是猜一个值', () => {
    const section = (body: string): string =>
      ['chapters:', body, 'foreshadowing:', '  path: f', 'overview:', '  path: o'].join('\n')

    // 空值、单引号、锚点、块标量、流式集合、别的类型
    expect(parseProjectConfig(section('  path:'))).toBeNull()
    expect(parseProjectConfig(section("  path: 'chapters'"))).toBeNull()
    expect(parseProjectConfig(section('  path: &anchor chapters'))).toBeNull()
    expect(parseProjectConfig(section('  path: |\n    chapters'))).toBeNull()
    expect(parseProjectConfig(section('  path: {a: b}'))).toBeNull()
    expect(parseProjectConfig(section('  path: true'))).toBeNull()
    expect(parseProjectConfig(section('  path: 42'))).toBeNull()
    // 引号没闭合
    expect(parseProjectConfig(section('  path: "chapters'))).toBeNull()
    // 顶层不是一个 `键:`
    expect(parseProjectConfig('not-a-mapping\n')).toBeNull()
    // 缩进的行没有可归属的分区
    expect(parseProjectConfig('  path: chapters\n')).toBeNull()
  })

  it('缺一段、或图鉴那一段缺 characters 时判为坏配置', () => {
    expect(parseProjectConfig('chapters:\n  path: chapters\n')).toBeNull()

    expect(
      parseProjectConfig(
        [
          'chapters:',
          '  path: chapters',
          'gallery:',
          '  path: gallery',
          'foreshadowing:',
          '  path: foreshadowing',
          'overview:',
          '  path: overview'
        ].join('\n')
      )
    ).toBeNull()
  })

  it('图鉴名是多段时判为坏配置', () => {
    expect(
      parseProjectConfig(
        [
          'chapters:',
          '  path: chapters',
          'gallery:',
          '  path: gallery',
          '  characters: 卷一/角色',
          'foreshadowing:',
          '  path: foreshadowing',
          'overview:',
          '  path: overview'
        ].join('\n')
      )
    ).toBeNull()
  })

  it('空文件判为坏配置（调用方据此写回默认值）', () => {
    expect(parseProjectConfig('')).toBeNull()
    expect(parseProjectConfig('# 只有注释\n')).toBeNull()
  })
})

describe('合并之前那一版的两份文件', () => {
  const legacy = [
    '# NIDE project configuration',
    '# Paths are relative to the project root.',
    'chapters: "chapters"',
    'gallery: "gallery"',
    'foreshadowing: "foreshadowing"',
    'overview: "overview"'
  ].join('\n')

  it('旧版 config.yml 是扁平四项，读得出来', () => {
    expect(parseLegacyProjectConfig(legacy)).toEqual({
      chapters: 'chapters',
      gallery: 'gallery',
      foreshadowing: 'foreshadowing',
      overview: 'overview'
    })
  })

  it('旧版也认手写的裸标量、反斜杠与未知键', () => {
    expect(
      parseLegacyProjectConfig(
        [
          'chapters: chapters\\volume-1',
          'gallery: gallery',
          'foreshadowing: f',
          'overview: o'
        ].join('\n')
      )
    ).toEqual({
      chapters: 'chapters/volume-1',
      gallery: 'gallery',
      foreshadowing: 'f',
      overview: 'o'
    })

    expect(parseLegacyProjectConfig(`${legacy}\nfuture-key: "whatever"`)).toEqual({
      chapters: 'chapters',
      gallery: 'gallery',
      foreshadowing: 'foreshadowing',
      overview: 'overview'
    })
  })

  it('新格式不是旧格式：两种写法不会互相误读', () => {
    expect(parseLegacyProjectConfig(serializeProjectConfig(DEFAULT_PROJECT_CONFIG))).toBeNull()
    // 反过来也一样：旧格式进不了新格式那一份
    expect(parseProjectConfig(legacy)).toBeNull()
  })

  it('旧版读不出来时给 null（缺键、值非法、缩进）', () => {
    expect(parseLegacyProjectConfig('')).toBeNull()
    expect(parseLegacyProjectConfig('chapters: chapters\n')).toBeNull()
    expect(
      parseLegacyProjectConfig(
        'chapters: ../outside\ngallery: gallery\nforeshadowing: f\noverview: o'
      )
    ).toBeNull()
    expect(parseLegacyProjectConfig('chapters:\n  path: chapters\n')).toBeNull()
  })

  it('旧版 gallery.yml 只认一个 characters 键', () => {
    expect(parseLegacyGalleryRegistry('# NIDE gallery registry\ncharacters: "人物"\n')).toBe('人物')
    expect(parseLegacyGalleryRegistry('characters: characters\n')).toBe('characters')
    expect(parseLegacyGalleryRegistry('')).toBeNull()
    expect(parseLegacyGalleryRegistry('# 只有注释\n')).toBeNull()
    expect(parseLegacyGalleryRegistry('characters: 12\n')).toBeNull()
    expect(parseLegacyGalleryRegistry('characters: 卷一/角色\n')).toBeNull()
    expect(parseLegacyGalleryRegistry('characters: ../外面\n')).toBeNull()
    expect(parseLegacyGalleryRegistry('characters:\n  characters: x\n')).toBeNull()
  })
})

describe('`.nide` 与文件树的关系', () => {
  it('树不列出 `.nide`，但它在磁盘上仍然存在', () => {
    expect(isIgnoredDirectoryName(PROJECT_META_DIR_NAME)).toBe(true)
    // 忽略表按原样比对：换一个大小写就是另一个目录，不该顺带被忽略
    expect(isIgnoredDirectoryName('.NIDE')).toBe(false)
  })
})
