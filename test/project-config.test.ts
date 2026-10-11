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
 * 落盘那一半（建 `.nide`、静默重建、`initializeProjectDirectory` 只在创建项目时
 * 调用）在 `src/main/services/project-config.service.ts`，它依赖 fs 与主进程日志，
 * 不在这里 —— 清单见 [测试](Testing) 与 [项目与欢迎窗口](Projects) 的手工验证。
 */

describe('配置的形状', () => {
  it('四个键就是配置项', () => {
    for (const key of ['chapters', 'gallery', 'foreshadowing', 'overview']) {
      expect(isProjectConfigKey(key)).toBe(true)
    }

    // 别的键不是配置项：`.nide` 将来会加东西，那些不该被当内容目录
    expect(isProjectConfigKey('chapter')).toBe(false)
    expect(isProjectConfigKey('chapters ')).toBe(false)
    expect(isProjectConfigKey('')).toBe(false)
  })

  it('默认值都是单段英文目录名', () => {
    expect(DEFAULT_PROJECT_CONFIG).toEqual({
      chapters: 'chapters',
      gallery: 'gallery',
      foreshadowing: 'foreshadowing',
      overview: 'overview'
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

describe('validateProjectConfig', () => {
  it('四项齐全且合法时通过', () => {
    const config = {
      chapters: 'chapters',
      gallery: 'gallery',
      foreshadowing: 'foreshadowing',
      overview: 'overview'
    }

    expect(validateProjectConfig(config)).toEqual(config)
  })

  it('缺一项就整份作废（不逐项回落）', () => {
    expect(
      validateProjectConfig({
        chapters: 'chapters',
        gallery: 'gallery',
        foreshadowing: 'foreshadowing'
      })
    ).toBeNull()
  })

  it('有一项非法就整份作废', () => {
    expect(
      validateProjectConfig({
        chapters: '../outside',
        gallery: 'gallery',
        foreshadowing: 'foreshadowing',
        overview: 'overview'
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
  it('只收已知的键与非空字符串值', () => {
    expect(
      sanitizeProjectConfigPatch({
        chapters: 'manuscript',
        unknown: 'x',
        gallery: 42,
        overview: null
      })
    ).toEqual({ chapters: 'manuscript' })
  })

  it('非对象给空补丁', () => {
    expect(sanitizeProjectConfigPatch(null)).toEqual({})
    expect(sanitizeProjectConfigPatch('chapters')).toEqual({})
  })
})

describe('applyProjectConfigPatch', () => {
  it('全部合格时替换，未提到的键保持原样', () => {
    const result = applyProjectConfigPatch(DEFAULT_PROJECT_CONFIG, { chapters: 'manuscript' })

    expect(result.ok).toBe(true)
    expect(result.config).toEqual({ ...DEFAULT_PROJECT_CONFIG, chapters: 'manuscript' })
  })

  it('有一项不合格就一项都不改', () => {
    const result = applyProjectConfigPatch(DEFAULT_PROJECT_CONFIG, {
      chapters: 'manuscript',
      gallery: '../outside'
    })

    expect(result.ok).toBe(false)
    expect(result.rejected).toEqual(['gallery'])
    expect(result.config).toEqual(DEFAULT_PROJECT_CONFIG)
  })

  it('指向 `.nide` 内部的值判为冲突', () => {
    const result = applyProjectConfigPatch(DEFAULT_PROJECT_CONFIG, { overview: '.nide/notes' })

    expect(result.ok).toBe(false)
    expect(result.conflicts).toEqual(['overview'])
    expect(result.config).toEqual(DEFAULT_PROJECT_CONFIG)
  })
})

describe('config.yml 的文本', () => {
  it('写出来的形状稳定：注释头 + 四个带引号的字段', () => {
    expect(serializeProjectConfig(DEFAULT_PROJECT_CONFIG)).toBe(
      [
        '# NIDE project configuration',
        '# Paths are relative to the project root.',
        'chapters: "chapters"',
        'gallery: "gallery"',
        'foreshadowing: "foreshadowing"',
        'overview: "overview"',
        ''
      ].join('\n')
    )
  })

  it('读写一个来回不丢东西（含引号）', () => {
    const config = {
      chapters: 'chapters/volume-1',
      gallery: 'a "quoted" name',
      foreshadowing: 'foreshadowing',
      overview: 'overview'
    }

    const text = serializeProjectConfig(config)
    // 值里的引号在写出来时必须被转义，否则读回来的是另一个值
    expect(text).toContain('gallery: "a \\"quoted\\" name"')
    expect(parseProjectConfig(text)).toEqual(config)
  })

  it('反斜杠按分隔符收敛成 /（Windows 上习惯写的那种路径）', () => {
    expect(
      parseProjectConfig(
        [
          'chapters: chapters\\volume-1',
          'gallery: gallery',
          'foreshadowing: foreshadowing',
          'overview: overview'
        ].join('\n')
      )
    ).toEqual({ ...DEFAULT_PROJECT_CONFIG, chapters: 'chapters/volume-1' })

    // 分隔符的语义优先于「名字里真的有反斜杠」：那样的目录在 Windows 上建不出来，
    // 与其留下一个各平台表现不同的值，不如判为坏配置
    expect(parseProjectConfig('chapters: "a\\\\b"\n')).toBeNull()
  })

  it('人手写的普通标量也认', () => {
    expect(
      parseProjectConfig(
        ['chapters: chapters', 'gallery: gallery', 'foreshadowing: f', 'overview: o'].join('\n')
      )
    ).toEqual({ chapters: 'chapters', gallery: 'gallery', foreshadowing: 'f', overview: 'o' })
  })

  it('未知的键被忽略，BOM 与 CRLF 都能读', () => {
    const text = [
      '\uFEFF# comment',
      'chapters: "chapters"',
      'gallery: "gallery"',
      'foreshadowing: "foreshadowing"',
      'overview: "overview"',
      'future-key: "whatever"',
      ''
    ].join('\r\n')

    expect(parseProjectConfig(text)).toEqual(DEFAULT_PROJECT_CONFIG)
  })

  it('坏掉的写法判为坏配置，而不是猜一个值', () => {
    // 空值、单引号、锚点、块标量、嵌套映射
    expect(parseProjectConfig('chapters:\n')).toBeNull()
    expect(parseProjectConfig("chapters: 'chapters'\n")).toBeNull()
    expect(parseProjectConfig('chapters: &anchor chapters\n')).toBeNull()
    expect(parseProjectConfig('chapters: |\n  chapters\n')).toBeNull()
    expect(parseProjectConfig('chapters:\n  nested: x\n')).toBeNull()
    expect(parseProjectConfig('chapters: true\n')).toBeNull()
    expect(parseProjectConfig('chapters: 42\n')).toBeNull()
    expect(parseProjectConfig('not-a-mapping\n')).toBeNull()
    // 引号没闭合
    expect(parseProjectConfig('chapters: "chapters\n')).toBeNull()
  })

  it('只有部分键时判为坏配置', () => {
    expect(parseProjectConfig('chapters: "chapters"\n')).toBeNull()
  })

  it('空文件判为坏配置（调用方据此写回默认值）', () => {
    expect(parseProjectConfig('')).toBeNull()
    expect(parseProjectConfig('# 只有注释\n')).toBeNull()
  })
})

describe('`.nide` 与文件树的关系', () => {
  it('树不列出 `.nide`，但它在磁盘上仍然存在', () => {
    expect(isIgnoredDirectoryName(PROJECT_META_DIR_NAME)).toBe(true)
    // 忽略表按原样比对：换一个大小写就是另一个目录，不该顺带被忽略
    expect(isIgnoredDirectoryName('.NIDE')).toBe(false)
  })
})
