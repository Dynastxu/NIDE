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
 * 表里只有纯文本、Markdown 与 YAML 三类。Markdown 的变体（.markdown / .mdown / .mkd）
 * 归到同一档，它们都是 Markdown 的不同写法。
 *
 * YAML 是给**图鉴**开的：图鉴的字段表（`config.yml`）与每一个条目都是 yml，而它们要
 * 在编辑器里以纯文本方式改（见 shared/project/gallery）。
 *
 * 没有 `.txt` 之外的「无扩展名」兜底：没有扩展名的文件可能是任何东西，
 * 而这一层的立场是「不认识就不解码」。
 */
const TEXT_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.txt': 'plaintext',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdown': 'markdown',
  '.mkd': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml'
} // TODO 实际上理应能使用记事本进行编辑的文件都应支持，后缀只做语法高亮的判断标准

/** 支持打开的扩展名集合（只读，供界面做快速判断） */
export const TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(TEXT_LANGUAGE_BY_EXTENSION)
)

/**
 * 目录不递归进去的目录名。比对按原样做（不折叠大小写之外的写法）。
 *
 * `.nide` 是宿主自己的元数据目录（项目配置、将来的缓存与索引），不是用户的稿子：
 * 它出现在树里只会让人以为那是一份需要自己维护的内容。它仍然在磁盘上、也仍然能被
 * 读写，只是不进这棵树 —— 与 `.git` 不同，用户没有理由展开它。
 */
const IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.nide',
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

/**
 * 宿主临时文件名的前缀。
 *
 * 宿主在项目目录里做**原子替换**时需要先写一个临时文件（临时文件必须与目标在同一个
 * 卷上，所以它落在目标所在的那一层，而不是用户数据目录）。前缀以点开头：
 * `validateEntryName` 拒绝以点开头的名字，所以用户在界面上永远建不出这种名字，
 * 也就撞不上宿主自己的临时件。
 *
 * 重命名（只改大小写那一步）与保存都用它。
 */
export const HOST_TEMP_FILE_PREFIX = '.nide-'

/** 这个文件名是不是宿主的临时件。为真时它不进文件树 —— 它不是一个内容条目 */
export function isHostTempFileName(name: string): boolean {
  return String(name ?? '').startsWith(HOST_TEMP_FILE_PREFIX)
}

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
  /**
   * 读一个内容目录里的章节列表（invoke），参数是目录绝对路径。
   *
   * 与 readDir 分开是因为它多做了**只读文件开头**（frontmatter）这一件事：章节列表
   * 要的是每一章的编号，而那个编号在正文之前。渲染进程自己做不到这件事 —— 它只有
   * 「把整个文件读进来」这一条路，为一章的编号去读几百 KiB 的正文不合适。
   */
  readChapters: 'host:project-read-chapters',
  /** 在一个目录里新建文件 / 文件夹（invoke），参数见 CreateEntryRequest */
  createEntry: 'host:project-create-entry',
  /** 把编辑器里的正文写回一个已存在的文件（invoke），参数见 WriteFileRequest */
  writeFile: 'host:project-write-file',
  /** 给一个已存在的文件 / 文件夹改名（invoke），参数见 RenameEntryRequest */
  renameEntry: 'host:project-rename-entry',
  /** 删除一个文件 / 文件夹（invoke），参数见 DeleteEntryRequest */
  deleteEntry: 'host:project-delete-entry'
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
  /**
   * 新文件的初始内容；省略即空文件。
   *
   * 存在的理由是「文件建出来那一刻就该是完整的」：一章的 Markdown 需要在开头带上
   * 章节属性（见 ./chapters），先建一个空文件再写一次等于给磁盘留一个中间态 ——
   * 那段时间里它是一章没有编号的稿子，而中间被中断（崩溃、拔盘）就会永远停在那里。
   *
   * 只在 `kind: 'file'` 时有意义；给目录传内容会被拒绝，而不是悄悄忽略。
   */
  content?: string
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

/*
 * 这里**没有**「补默认扩展名」这一步，而且是刻意的。
 *
 * 用户敲什么名字，磁盘上就是什么名字 —— 新建与重命名因此是同一条规则，不必解释
 * 「为什么新建会多出 .md 而改名不会」。代价说清楚：一个没有扩展名的文件在树里是
 * `not-text`，点不进编辑器（见上面的 TEXT_LANGUAGE_BY_EXTENSION）。这是**用户自己
 * 起的名字**带来的结果，而不是宿主背着他改的 —— 前者他改个名字就好了，后者他连
 * 文件叫什么都猜不到。
 */

// ============ 重命名 ============

/**
 * 重命名失败的原因。界面按它换文案，与新建失败的那一类分开：
 * 「这个名字已经有了」在两种动作里说法不同（一个是「建不了」，一个是「改不了」）。
 */
export type RenameEntryFailureReason =
  /** 名字非法（空、含路径分隔符或非法字符、`.` / `..`） */
  | 'invalid-name'
  /** 同级已经有一个同名条目。**绝不覆盖** */
  | 'already-exists'
  /** 目标不是文件也不是目录（已被删掉、是个链接、或者类型不对） */
  | 'not-a-file'
  /** 路径不可用、跑出项目、没有权限等等 */
  | 'unreadable'

export type RenameEntryResult =
  | { ok: true; path: string; previousPath: string; kind: FileTreeEntry['kind'] }
  | { ok: false; reason: RenameEntryFailureReason }

/**
 * 「给一个条目改名」的请求。
 *
 * `targetPath` 是**被右键的那个条目**的绝对路径，`name` 是他输入的新名字。
 * 目录由主进程从 `targetPath` 推导（就是它自己所在的那一层）—— 渲染进程
 * 因此指定不了「移到哪儿」，重命名也就不会变成一次搬移。
 */
export interface RenameEntryRequest {
  /** 要改名的文件或目录的绝对路径 */
  targetPath: string
  /** 用户输入的新名字（单段） */
  name: string
}

// ============ 删除 ============

/**
 * 删除失败的原因。
 */
export type DeleteEntryFailureReason =
  /**
   * 用户在二次确认框里选了「取消」。
   *
   * **不是失败**：这一问是动作自己问的（见 main/confirm.ts），而「不问就不做」
   * 正是那一问的答案。界面不该因此提示任何东西，日志也只该记一条 info。
   */
  | 'cancelled'
  /** 目录不是空的（宿主目前一律递归删，所以这码只在将来收紧时才会出现） */
  | 'not-empty'
  /** 目标不是文件也不是目录（已被删掉、是个链接、或者类型不对） */
  | 'not-a-file'
  /** 要删的是项目根自己 —— 那等于把整个项目从磁盘上抹掉 */
  | 'is-project-root'
  /** 路径不可用、跑出项目、没有权限等等 */
  | 'unreadable'

export type DeleteEntryResult =
  | { ok: true; path: string; kind: FileTreeEntry['kind'] }
  /**
   * 目标本来就不在了。
   *
   * **不是失败**：用户要的那个状态（它不在了）已经成立。`kind` 是 null，因为已经
   * 没有任何东西可以问了 —— 界面不需要据此分支，它只关心「树该不该刷」。
   */
  | { ok: true; path: string; kind: null }
  | { ok: false; reason: DeleteEntryFailureReason }

/**
 * 「删除一个条目」的请求。
 *
 * 只有路径，没有「删多深」这类参数：**目录一律连同里面的东西一起删**。删一个
 * 非空目录还得先让人手清空，那是把一件本来一步就能做完的事拆成几步。
 *
 * 这是宿主唯一**不可撤销**的写盘动作，所以二次确认挂在主进程的动作出口上
 * （见 main/confirm.ts）—— 无论谁发起删除都经过那一问，界面不自己弹框。这个请求
 * 因此只描述**删什么**，不描述怎么问：主进程只认路径，它没法替用户回答「你确定吗」，
 * 能做的是把边界与错误说清楚。
 */
export interface DeleteEntryRequest {
  /** 要删掉的文件或目录的绝对路径 */
  targetPath: string
}

// ============ 保存（把正文写回磁盘） ============

/**
 * 写回失败的归类。界面按它换文案。
 *
 * 与读取失败的原因**故意不同名**：同一条路径读不出来与写不进去是两件事，界面要说的
 * 话也不一样（「读不到，重试可能就好了」对不上「写不进去，磁盘满了」）。
 */
export type FileWriteFailureReason =
  /** 路径形状不对（空、不是字符串），或者正文不是字符串 */
  | 'invalid-path'
  /** 跑出当前项目之外 —— 与读取共用同一条范围校验 */
  | 'outside-project'
  /** 这个格式宿主不解码，也就不该由它写回（写回去等于毁掉一份它读不懂的内容） */
  | 'not-text'
  /** 目标已经不在了、是个符号链接、或者不是普通文件 */
  | 'not-a-file'
  /** 正文超出单个文本文件的上限（见 MAX_TEXT_FILE_BYTES） */
  | 'too-large'
  /** 没有权限、磁盘满、文件被别的程序独占等等 */
  | 'unreadable'

export type FileWriteResult =
  { ok: true; path: string } | { ok: false; reason: FileWriteFailureReason }

/**
 * 「把正文写回一个文件」的请求。
 *
 * 只有路径与正文：写到哪儿由**路径自己**决定，没有第二个位置参数 —— 保存不是另存为，
 * 它覆盖的必须正是这个标签页当初读的那个文件。路径落在哪个根之内由主进程对照当前
 * 项目判断，渲染进程声明不了自己的活动范围。
 *
 * ## 冲突由用户的那一下点击裁决
 *
 * 磁盘上的版本与编辑器里这一份哪个新，宿主**不猜**：保存是用户显式按下的动作，
 * 意思就是「以我手里这份为准」。宿主能做的是把该拒的拒掉（目标没了、路径跑出项目、
 * 目标是链接），而不是替他决定要不要覆盖。
 */
export interface WriteFileRequest {
  /** 要写回的文件绝对路径 */
  filePath: string
  /** 编辑器里的正文 */
  content: string
}
