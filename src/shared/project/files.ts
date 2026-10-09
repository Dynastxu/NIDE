/**
 * 项目文件树的契约：目录条目、排序、忽略规则与「这个文件能不能在编辑器里打开」。
 *
 * 这一层被主进程（读盘）、preload（转发）与渲染进程（渲染树）三方共用，所以
 * **不能** import electron / fs / DOM。所有判断都写成纯函数，测试不必起 electron。
 *
 * 打开文件的边界刻意只有一条：**纯文本与 Markdown**。其余格式（图片、PDF、
 * 压缩包、docx 等）不解码也不预览，界面把它们标成不可打开 —— 用一句「不支持」
 * 挡住，比解码出一屏乱码诚实。
 */

/** 目录 / 文件条目 */
export type FileTreeEntry =
  | {
      kind: 'directory'
      /** 绝对路径 */
      path: string
      /** 显示名（路径最后一段） */
      name: string
    }
  | {
      kind: 'file'
      /** 绝对路径 */
      path: string
      /** 显示名（路径最后一段） */
      name: string
      /**
       * 能不能在编辑器里打开。
       *
       * 为 false 时条目仍然显示（用户能看见目录里确实有它），但点不动，
       * 并给出 reason 说明原因。
       */
      supported: boolean
      /** 不支持的归类，界面据此换文案 */
      reason?: FileUnsupportedReason
    }

/**
 * 文件打不开的归类。
 *
 * 分开的原因只有文案：扩展名不认识是「设计上不支持」，读取失败是「这台机器上
 * 这次读不到」，前者永远如此，后者重试可能就好了。
 */
export type FileUnsupportedReason = 'not-text' | 'unreadable' | 'too-large'

/** 读取文件内容的失败原因 */
export type FileReadFailureReason = 'invalid-path' | 'outside-project' | 'not-a-file' | 'unreadable'

export type FileReadResult =
  { ok: true; path: string; content: string } | { ok: false; reason: FileReadFailureReason }

/** 读取目录的失败原因 */
export type DirReadFailureReason =
  'invalid-path' | 'outside-project' | 'not-a-directory' | 'unreadable'

export type DirReadResult =
  { ok: true; path: string; entries: FileTreeEntry[] } | { ok: false; reason: DirReadFailureReason }

/**
 * 能打开的扩展名 -> Monaco 语言 id。
 *
 * 表里只有纯文本与 Markdown 两类。Markdown 的变体（.markdown / .mdown / .mkd）
 * 归到同一档，它们都是 Markdown 的不同写法。
 *
 * 没有 `.txt` 之外的「无扩展名」兜底：没有扩展名的文件可能是任何东西，
 * 而这一层的立场是「不认识就不解码」。
 */
const TEXT_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.txt': 'plaintext',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdown': 'markdown',
  '.mkd': 'markdown'
}

/** 支持打开的扩展名集合（只读，供界面做快速判断） */
export const TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(TEXT_LANGUAGE_BY_EXTENSION)
)

/** 目录不递归进去的目录名。比对按原样做（不折叠大小写之外的写法） */
const IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  // 打包 / 构建产物：项目里通常是空目录或与源码重复的副本，展开只添噪声
  'dist',
  'out',
  '.next',
  '.cache',
  '__pycache__'
])

/**
 * 单个文件的读取上限（字符数级别的近似：按字节判断）。
 *
 * 20 MiB 远超任何一章小说稿。设它是为了不让误点的可执行文件、日志或数据库
 * 把整个渲染进程拖住 —— 超过就归到「不支持」。
 */
export const MAX_TEXT_FILE_BYTES = 20 * 1024 * 1024

/** 取小写扩展名（含点）。没有扩展名时返回空串 */
export function extensionOf(filePath: string): string {
  const name = baseNameOf(filePath)
  const dot = name.lastIndexOf('.')
  // 前导点开头的隐藏文件（.gitignore）不算「有扩展名」
  if (dot <= 0) return ''
  return name.slice(dot).toLowerCase()
}

/** 路径最后一段。末尾分隔符已经在 normalizeProjectPath 里处理过 */
export function baseNameOf(target: string): string {
  const segments = String(target ?? '')
    .split(/[\\/]/)
    .filter(Boolean)
  return segments.pop() ?? String(target ?? '')
}

/** 是不是 Markdown（决定编辑器的语言态度，也决定图标） */
export function isMarkdownPath(filePath: string): boolean {
  return TEXT_LANGUAGE_BY_EXTENSION[extensionOf(filePath)] === 'markdown'
}

/** 这个文件是不是「宿主支持的纯文本 / Markdown」 */
export function isSupportedTextPath(filePath: string): boolean {
  return extensionOf(filePath) in TEXT_LANGUAGE_BY_EXTENSION
}

/** 给 Monaco 的语言 id。不支持的扩展名回落到 plaintext */
export function languageForPath(filePath: string): string {
  return TEXT_LANGUAGE_BY_EXTENSION[extensionOf(filePath)] ?? 'plaintext'
}

/** 该目录名是否在忽略表里（`.git` 这类） */
export function isIgnoredDirectoryName(name: string): boolean {
  return IGNORED_DIRECTORY_NAMES.has(name)
}

/**
 * 项目根目录内的路径比较用的 key。
 *
 * 和 shared/project 的 projectPathKey 分开：那个是「同一个项目吗」，
 * 这个是「同一个文件吗」，但规则一致 —— 去掉末尾分隔符，按调用方给的
 * 大小写语义折叠。Windows 的路径不区分大小写，由主进程传入结论。
 */
export function filePathKey(target: string, caseInsensitive: boolean): string {
  const trimmed = String(target ?? '').replace(/[\\/]+$/, '')
  return caseInsensitive ? trimmed.toLowerCase() : trimmed
}

/**
 * target 是不是 root 之内（或就是 root 本身）。
 *
 * 逐段比较而不是 `startsWith`：`D:\Novel2` 以 `D:\Novel` 开头，但它是另一个目录。
 * 用段落切分比对，前缀相同的兄弟目录不会被误判成「在里面」。
 *
 * `caseInsensitive` 由调用方按平台给（与 projectPathKey 同理：渲染进程里没有
 * 完整的 `process`，这一层不该自己读 `process.platform`）。
 */
export function isInsideProject(root: string, target: string, caseInsensitive: boolean): boolean {
  const split = (value: string): string[] =>
    filePathKey(value, caseInsensitive).replace(/\\/g, '/').split('/').filter(Boolean)

  const rootParts = split(root)
  const targetParts = split(target)

  if (rootParts.length === 0 || targetParts.length < rootParts.length) return false

  return rootParts.every((part, index) => part === targetParts[index])
}

/**
 * 目录条目的排序：目录在前，同类按名字比较。
 *
 * 用 `Intl.Collator` 而不是 `<`：中文文件名按 `<` 排出来是码位顺序，看起来是乱的。
 * collator 由调用方传入（`numeric` 让「第2章」排在「第10章」前面），这样这个
 * 函数在测试里可以注入固定 locale。
 */
export function sortTreeEntries(
  entries: FileTreeEntry[],
  collator: Intl.Collator
): FileTreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return collator.compare(a.name, b.name)
  })
}

/** 排序用的默认比较器：按当前语言，数字按数值大小（2 在 10 前面） */
export function createNameCollator(locales?: string | string[]): Intl.Collator {
  return new Intl.Collator(locales, { numeric: true, sensitivity: 'base' })
}

/**
 * 渲染进程与主进程共用的 IPC 通道名。
 *
 * 和 PROJECT_CHANNELS 一样集中在这里：拼错通道名没有编译错误，
 * 只会在运行时静默失效。
 */
export const PROJECT_FILE_CHANNELS = {
  /** 读一层目录，参数是目录绝对路径（invoke） */
  readDir: 'host:project-read-dir',
  /** 读一个文本文件，参数是文件绝对路径（invoke） */
  readFile: 'host:project-read-file',
  /** 在一个目录里新建文件 / 文件夹（invoke），参数见 CreateEntryRequest */
  createEntry: 'host:project-create-entry'
} as const

// ============ 新建文件 / 文件夹 ============

/**
 * 新条目建在哪儿。
 *
 * 两种**目标目录**，右键菜单的两种情形正好对应它们：
 *
 * - 右键一个文件夹 -> 建在**它内部**；
 * - 右键一个文件   -> 建在**它的同级**（同目录）。
 *
 * 判别放在主进程而不是渲染进程：那是「同名条目已存在吗」的同一条判断链，
 * 由主进程一次做完。渲染进程只报「我右键的是谁」。
 */
export type CreateEntryKind = 'file' | 'directory'

/** 新建条目的失败原因。界面按它换文案 */
export type CreateEntryFailureReason =
  /** 名字非法（空、含路径分隔符或非法字符、`.` / `..`） */
  | 'invalid-name'
  /** 同级已经有一个同名条目。**绝不覆盖** */
  | 'already-exists'
  /** 目标路径是文件，或者类型不对（父级不是目录、要建的目录名已被文件占着） */
  | 'not-a-directory'
  /** 路径不可用、跑出项目、没有权限、磁盘满等等 */
  | 'unreadable'

export type CreateEntryResult =
  | { ok: true; path: string; kind: CreateEntryKind }
  | { ok: false; reason: CreateEntryFailureReason }

/**
 * 「新建一个条目」的请求。
 *
 * `targetPath` 是用户**右键的那个条目**的绝对路径（文件或目录都行），
 * `name` 是他输入的单段名字。目标目录由主进程从 targetPath 推出来
 * （见 CreateEntryKind 的说明）—— 渲染进程不指定目录，也就没有机会指到别处。
 */
export interface CreateEntryRequest {
  kind: CreateEntryKind
  /** 被右键的那个文件或目录的绝对路径 */
  targetPath: string
  /** 用户输入的名字（单段，未补扩展名） */
  name: string
}

/**
 * 名字校验的失败原因。
 *
 * 和 CreateEntryFailureReason 分开：这个是**纯逻辑**的结论，可以在用户敲字时
 * 就给出（不必等一次 IPC 往返），所以它只包含「名字本身不对」这一类。
 */
export type InvalidNameReason =
  | 'empty'
  /** 名字里有路径分隔符，或者就是 `.` / `..` —— 那是在试图指定别的目录 */
  | 'path-separator'
  /** 当前平台文件名里不允许出现的字符 */
  | 'illegal-character'
  /** 以点开头。宿主生成的条目不该是隐藏文件，看不见只会让人以为没建成 */
  | 'leading-dot'
  /** 名字最后一段是空白或点：Windows 会静默去掉它们，于是「建好了但名字不是那个」 */
  | 'trailing-space-or-dot'
  /** 超出文件系统的单段长度上限 */
  | 'too-long'

export type NameValidation = { ok: true; name: string } | { ok: false; reason: InvalidNameReason }

/**
 * 文件名单段长度上限。
 *
 * 取 255 是按最严的常见文件系统（ext4 / NTFS 都是 255 个字符）。这里按**字符**
 * 算而不是字节：中日文名按字节算会莫名其妙地变得很短，而常见文件系统对多字节
 * 名字的限制也是按字符数给的。
 */
export const MAX_FILE_NAME_LENGTH = 255

/**
 * Windows 不允许出现在文件名里的字符：`\ / : * ? " < > |`。
 *
 * 在所有平台上一律拒绝，不做「按平台放宽」：项目可能被同步到另一台机器或塞进
 * 压缩包，一个在 Linux 上合法、在 Windows 上打不开的名字是个迟早要炸的雷。
 * `/` 与 `\` 单独归到 path-separator（那是另一类错误，文案也不同）。
 */
const ILLEGAL_NAME_CHARS = /[:*?"<>|]/

/**
 * 控制字符（含换行、制表）同样不能出现在文件名里。
 *
 * 关掉 no-control-regex 是**刻意**的：那条规则防的是「拿控制字符当分隔符」，
 * 而这里正是要匹配它们。
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * 校验一段「要新建的条目的名字」（不是路径）。
 *
 * 只接受**单段**名字：界面上让用户输入的是名字，不是路径。允许 `../x` 这类输入
 * 等于把「建在哪儿」的决定权从界面交回给用户输入，而这一层的立场是「新条目只能
 * 落在用户右键的那个目录里」。
 *
 * 返回值里的 name 是 trim 之后的：用户多敲的空格不该变成文件名的一部分 ——
 * 那样文件建出来是对的，名字却和他在树里读到的不一样。
 */
export function validateEntryName(raw: string): NameValidation {
  const name = String(raw ?? '').trim()

  if (name.length === 0) return { ok: false, reason: 'empty' }
  if (name === '.' || name === '..') return { ok: false, reason: 'path-separator' }
  if (/[\\/]/.test(name)) return { ok: false, reason: 'path-separator' }
  if (ILLEGAL_NAME_CHARS.test(name) || CONTROL_CHARS.test(name)) {
    return { ok: false, reason: 'illegal-character' }
  }
  if (name.startsWith('.')) return { ok: false, reason: 'leading-dot' }
  if (/[. ]$/.test(name)) return { ok: false, reason: 'trailing-space-or-dot' }
  if ([...name].length > MAX_FILE_NAME_LENGTH) return { ok: false, reason: 'too-long' }

  return { ok: true, name }
}

/**
 * 新建文件时用哪个扩展名，决定「这个文件能不能立刻在编辑器里打开」。
 *
 * 默认给 `.md`：这是宿主的核心用途（小说工程），而一个没有扩展名的文件在树里
 * 是「不可打开」的 —— 让用户敲完名字就得到一个点不动的文件说不过去。
 * 用户自己写了扩展名就以他写的为准（`第一章.txt`、`notes.markdown` 都算数）。
 */
export const DEFAULT_NEW_FILE_EXTENSION = '.md'

/**
 * 把用户输入的名字补全成一个可用的文件名。
 *
 * 有扩展名就原样用；没有就补上 `.md`。只在 `validateEntryName` 通过之后调用 ——
 * 它不负责校验，只负责补全。
 */
export function completeFileName(name: string): string {
  return extensionOf(name) === '' ? `${name}${DEFAULT_NEW_FILE_EXTENSION}` : name
}
