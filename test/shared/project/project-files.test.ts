import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NEW_FILE_EXTENSION,
  MAX_FILE_NAME_LENGTH,
  MAX_TEXT_FILE_BYTES,
  baseNameOf,
  completeFileName,
  createNameCollator,
  extensionOf,
  filePathKey,
  isIgnoredDirectoryName,
  isInsideProject,
  isMarkdownPath,
  isSupportedTextPath,
  languageForPath,
  sortTreeEntries,
  validateEntryName
} from '@shared/project'
import type { FileTreeEntry } from '@shared/project'

/**
 * 项目文件树的纯逻辑。
 *
 * 覆盖的都是**会静默出错**的地方：把「不支持的格式」判成支持（点开一屏乱码）、
 * 把项目外的路径判成项目内（沙箱形同虚设）、把 `D:\Novel2` 判成 `D:\Novel` 之内。
 * 读盘部分（project-files.service）依赖 fs 与 electron，不在这里。
 */

describe('extensionOf / baseNameOf', () => {
  it('取小写扩展名，Windows 与 POSIX 分隔符都认', () => {
    expect(extensionOf('D:\\Novel\\chapter1.MD')).toBe('.md')
    expect(extensionOf('/home/me/novel/chapter1.Txt')).toBe('.txt')
  })

  it('没有扩展名时给空串，而不是整个文件名', () => {
    expect(extensionOf('/home/me/novel/README')).toBe('')
    expect(extensionOf('D:\\Novel\\LICENSE')).toBe('')
  })

  it('隐藏文件的前导点不算扩展名', () => {
    // `.gitignore` 不是「扩展名为 .gitignore 的文件」
    expect(extensionOf('/home/me/novel/.gitignore')).toBe('')
    expect(extensionOf('/home/me/novel/.eslintrc.json')).toBe('.json')
  })

  it('最后一段就是显示名', () => {
    expect(baseNameOf('D:\\Novel\\卷一\\第一章.md')).toBe('第一章.md')
    expect(baseNameOf('/home/me/novel/')).toBe('novel')
  })
})

describe('支持打开的格式', () => {
  it('只有纯文本与 Markdown 算支持', () => {
    expect(isSupportedTextPath('a.txt')).toBe(true)
    expect(isSupportedTextPath('a.md')).toBe(true)
    expect(isSupportedTextPath('a.markdown')).toBe(true)
    expect(isSupportedTextPath('a.mdown')).toBe(true)
    expect(isSupportedTextPath('a.mkd')).toBe(true)

    // 其余格式一律走「不解码」这条路
    for (const name of ['a.png', 'a.pdf', 'a.docx', 'a.json', 'a.ts', 'a', 'a.md.bak']) {
      expect(isSupportedTextPath(name), name).toBe(false)
    }
  })

  it('Markdown 的各个写法都认，且与纯文本区分开', () => {
    expect(isMarkdownPath('/n/outline.MD')).toBe(true)
    expect(isMarkdownPath('/n/outline.markdown')).toBe(true)
    expect(isMarkdownPath('/n/notes.txt')).toBe(false)
    expect(isMarkdownPath('/n/cover.png')).toBe(false)
  })

  it('语言 id 认不出来时回落到 plaintext，而不是抛异常', () => {
    expect(languageForPath('/n/ch1.md')).toBe('markdown')
    expect(languageForPath('/n/ch1.txt')).toBe('plaintext')
    // 不可打开的文件也可能被问到语言（比如宿主推来一条 file-changed）
    expect(languageForPath('/n/cover.png')).toBe('plaintext')
  })

  it('大小上限是一个正数常量，界面与读盘两侧共用', () => {
    expect(MAX_TEXT_FILE_BYTES).toBeGreaterThan(0)
  })
})

describe('忽略的目录', () => {
  it('版本控制目录与依赖目录不进树', () => {
    for (const name of ['.git', '.hg', '.svn', 'node_modules', 'dist', 'out']) {
      expect(isIgnoredDirectoryName(name), name).toBe(true)
    }
  })

  it('普通目录与相似名字不会被误伤', () => {
    for (const name of ['chapters', 'notes', '.gitignore', 'git', 'output', 'src']) {
      expect(isIgnoredDirectoryName(name), name).toBe(false)
    }
  })
})

describe('isInsideProject', () => {
  it('项目根自己算在里面', () => {
    expect(isInsideProject('D:\\Novel', 'D:\\Novel', true)).toBe(true)
    expect(isInsideProject('/home/me/novel', '/home/me/novel', false)).toBe(true)
  })

  it('子目录与子文件算在里面', () => {
    expect(isInsideProject('D:\\Novel', 'D:\\Novel\\卷一\\ch1.md', true)).toBe(true)
    expect(isInsideProject('/home/me/novel', '/home/me/novel/ch1.md', false)).toBe(true)
  })

  it('前缀相同的兄弟目录不算在里面', () => {
    // 「以 D:\Novel 开头」不等于「在 D:\Novel 之内」—— 这是 startsWith 的经典坑
    expect(isInsideProject('D:\\Novel', 'D:\\Novel2\\ch1.md', true)).toBe(false)
    expect(isInsideProject('/home/me/novel', '/home/me/novel-archive/ch1.md', false)).toBe(false)
  })

  it('跑出去的路径不算在里面', () => {
    expect(isInsideProject('D:\\Novel', 'D:\\Other\\ch1.md', true)).toBe(false)
    expect(isInsideProject('/home/me/novel', '/etc/passwd', false)).toBe(false)
    // 「项目内的相对跳转」在拼成绝对路径之后同样会被判出来
    expect(isInsideProject('/home/me/novel', '/home/me/other', false)).toBe(false)
  })

  it('大小写按调用方给的平台语义折叠', () => {
    expect(isInsideProject('D:\\Novel', 'd:\\novel\\ch1.md', true)).toBe(true)
    expect(isInsideProject('D:\\Novel', 'd:\\novel\\ch1.md', false)).toBe(false)
  })

  it('分隔符混写不影响判断', () => {
    expect(isInsideProject('D:\\Novel', 'D:\\Novel/卷一/ch1.md', true)).toBe(true)
  })

  it('空路径与残缺路径一律不在里面', () => {
    expect(isInsideProject('', 'D:\\Novel\\ch1.md', true)).toBe(false)
    expect(isInsideProject('D:\\Novel', '', true)).toBe(false)
    expect(isInsideProject('D:\\Novel', 'D:\\', true)).toBe(false)
  })
})

describe('filePathKey', () => {
  it('去掉末尾分隔符，并按需折叠大小写', () => {
    expect(filePathKey('D:\\Novel\\', true)).toBe('d:\\novel')
    expect(filePathKey('D:\\Novel\\', false)).toBe('D:\\Novel')
  })
})

describe('sortTreeEntries', () => {
  const collator = createNameCollator('zh-CN')

  const file = (name: string): FileTreeEntry => ({
    kind: 'file',
    path: `/n/${name}`,
    name,
    supported: isSupportedTextPath(name)
  })
  const dir = (name: string): FileTreeEntry => ({
    kind: 'directory',
    path: `/n/${name}`,
    name
  })

  it('目录排在文件前面', () => {
    const sorted = sortTreeEntries([file('z.md'), dir('a')], collator)
    expect(sorted.map((entry) => entry.name)).toEqual(['a', 'z.md'])
  })

  it('同类按名字比较，数字按数值大小', () => {
    const sorted = sortTreeEntries(
      [file('第10章.md'), file('第2章.md'), file('第1章.md')],
      collator
    )
    expect(sorted.map((entry) => entry.name)).toEqual(['第1章.md', '第2章.md', '第10章.md'])
  })

  it('不改动传入的数组', () => {
    const input = [file('b.md'), file('a.md')]
    sortTreeEntries(input, collator)
    expect(input.map((entry) => entry.name)).toEqual(['b.md', 'a.md'])
  })

  it('空列表给空列表', () => {
    expect(sortTreeEntries([], collator)).toEqual([])
  })
})

/**
 * 新建条目的名字校验。
 *
 * 这一层是「用户敲字时就给出的结论」，所以覆盖重点是**别把非法名字放过去** ——
 * 放过去之后要么建出一个打不开的文件，要么在 Windows 上被系统静默改名，
 * 而用户看到的是「建好了但名字不对」。
 */
describe('validateEntryName', () => {
  const reasonOf = (input: string): string | null => {
    const result = validateEntryName(input)
    return result.ok ? null : result.reason
  }

  it('正常名字通过，并返回 trim 之后的值', () => {
    const result = validateEntryName('  第一章  ')
    expect(result).toEqual({ ok: true, name: '第一章' })
  })

  it('中文、空格、括号、连字符都算合法', () => {
    for (const name of ['第一章 开端', 'ch-01', 'notes (draft)', 'a.b.c']) {
      expect(reasonOf(name), name).toBeNull()
    }
  })

  it('空名字与纯空白被拒', () => {
    expect(reasonOf('')).toBe('empty')
    expect(reasonOf('   ')).toBe('empty')
    expect(reasonOf('\t')).toBe('empty')
  })

  it('路径分隔符与 . / .. 被拒 —— 那是在指定别的目录', () => {
    expect(reasonOf('a/b')).toBe('path-separator')
    expect(reasonOf('a\\b')).toBe('path-separator')
    expect(reasonOf('..')).toBe('path-separator')
    expect(reasonOf('.')).toBe('path-separator')
    expect(reasonOf('../escape')).toBe('path-separator')
  })

  it('Windows 非法字符在所有平台都被拒', () => {
    // 项目可能被同步到别的机器：在 Linux 上合法、在 Windows 上打不开的名字是个雷
    for (const name of ['a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
      expect(reasonOf(name), name).toBe('illegal-character')
    }
  })

  it('控制字符被拒', () => {
    expect(reasonOf('a\nb')).toBe('illegal-character')
    expect(reasonOf('a\u0000b')).toBe('illegal-character')
    expect(reasonOf('a\u007fb')).toBe('illegal-character')
  })

  it('以点开头被拒 —— 宿主不生成隐藏文件', () => {
    expect(reasonOf('.gitignore')).toBe('leading-dot')
    expect(reasonOf('.')).toBe('path-separator') // 顺序：. 先被判成路径
  })

  it('以点结尾被拒 —— Windows 会静默去掉它', () => {
    expect(reasonOf('a.')).toBe('trailing-space-or-dot')
    expect(reasonOf('a...')).toBe('trailing-space-or-dot')
  })

  it('首尾空白被 trim 掉，而不是变成名字的一部分', () => {
    // 建出来的文件名和用户在树里读到的不一样，是最难查的一类「诡异」
    expect(validateEntryName('  a  ')).toEqual({ ok: true, name: 'a' })
    // 中间的空格是名字的一部分，保留
    expect(validateEntryName('a b')).toEqual({ ok: true, name: 'a b' })
  })

  it('超长名字被拒，边界按字符数算', () => {
    expect(reasonOf('a'.repeat(MAX_FILE_NAME_LENGTH))).toBeNull()
    expect(reasonOf('a'.repeat(MAX_FILE_NAME_LENGTH + 1))).toBe('too-long')
    // 中日文按字符算，不按字节 —— 否则中文名会莫名其妙地只能写三分之一长
    expect(reasonOf('中'.repeat(MAX_FILE_NAME_LENGTH))).toBeNull()
  })
})

describe('completeFileName', () => {
  it('没有扩展名时补默认扩展名', () => {
    expect(completeFileName('第一章')).toBe(`第一章${DEFAULT_NEW_FILE_EXTENSION}`)
    expect(completeFileName('notes')).toBe('notes.md')
  })

  it('用户自己写了扩展名就用他的', () => {
    expect(completeFileName('第一章.txt')).toBe('第一章.txt')
    expect(completeFileName('outline.markdown')).toBe('outline.markdown')
    // 任何扩展名都尊重，包括宿主打不开的那些
    expect(completeFileName('cover.png')).toBe('cover.png')
  })

  it('默认补出来的文件是「能打开」的 —— 敲完名字就得到点不动的文件说不过去', () => {
    expect(isSupportedTextPath(completeFileName('第一章'))).toBe(true)
    expect(isMarkdownPath(completeFileName('第一章'))).toBe(true)
  })
})
