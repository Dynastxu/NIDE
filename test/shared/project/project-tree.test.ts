import { describe, expect, it } from 'vitest'
import { buildTreeRows, createChildVisibility, treeBaseName } from '@shared/project'
import type { BuildRowsInput, FileTreeEntry, TreeRow } from '@shared/project'

/**
 * 文件树的**可见性判定**与**行表构建**。
 *
 * 这一组用例是为一个真实 bug 补的：没有钉任何目录时，「可见集合」里只装了根目录，
 * 而行表却拿**每个节点自己**的路径去查那个集合 —— 于是根的子项被整片过滤掉，树上
 * 只剩根这一行。之前的用例没抓到它，原因有两个：行表构建当时埋在渲染进程的组件里，
 * 而那个 `depth > 0` 的短路刚好让根的子项绕过了过滤。
 *
 * 现在两者都在 shared 的纯逻辑里，所以能直接测；下面还让它们合起来跑一遍端到端。
 */

const LABELS = {
  loading: 'loading',
  error: (reason: string) => `error:${reason}`
}

const dir = (path: string): FileTreeEntry => ({
  kind: 'directory',
  path,
  name: treeBaseName(path)
})

const file = (path: string): FileTreeEntry => ({
  kind: 'file',
  path,
  name: treeBaseName(path),
  supported: true
})

/** 默认：所有目录的子项都可见（等于「没有只看某一支」） */
const allVisible = (): boolean => true

/**
 * 默认：「读过且为空」的判定就照 children 来 —— 有这一项、长度为零就是空目录。
 *
 * 与 ExplorerView 传给 buildTreeRows 的那个函数规则一致（那边也只是查同一张表）。
 */
function emptyFromChildren(
  children: Record<string, FileTreeEntry[]>
): (dirPath: string) => boolean {
  return (dirPath) => (children[dirPath]?.length ?? -1) === 0
}

function input(overrides: Partial<BuildRowsInput> = {}): BuildRowsInput {
  const root = '/p'
  const children = overrides.children ?? { [root]: [] }

  return {
    roots: [root],
    children,
    errors: {},
    loading: {},
    expanded: { [root]: true },
    isChildVisible: allVisible,
    knownEmpty: emptyFromChildren(children),
    labels: LABELS,
    ...overrides
  }
}

/** 只取条目行的 [名字, 层级] */
function outline(rows: TreeRow[]): [string, number][] {
  return rows
    .filter((row): row is Extract<TreeRow, { kind: 'entry' }> => row.kind === 'entry')
    .map((row) => [row.entry.name, row.depth])
}

function guidesOf(rows: TreeRow[], name: string): boolean[] | undefined {
  return rows
    .filter((row): row is Extract<TreeRow, { kind: 'entry' }> => row.kind === 'entry')
    .find((row) => row.entry.name === name)?.guides
}

// ============ 可见性判定 ============

const ROOT = 'C:\\Users\\dynas\\Documents\\test'
const SUB = `${ROOT}\\新建文件夹`
const DEEP = `${SUB}\\卷一`
const OTHER = `${ROOT}\\别的分支`

describe('createChildVisibility', () => {
  it('**没有钉任何目录时，任何目录的子项都可见** —— 这就是那个 bug 的判据', () => {
    const visible = createChildVisibility([ROOT], {})

    expect(visible(ROOT)).toBe(true)
    expect(visible(SUB)).toBe(true)
    expect(visible(DEEP)).toBe(true)
  })

  it('根无条件可见，否则整棵树会被自己挡住', () => {
    expect(createChildVisibility([ROOT], { [SUB]: true })(ROOT)).toBe(true)
  })

  it('钉住一个目录后：它自己与它的子孙可见', () => {
    const visible = createChildVisibility([ROOT], { [SUB]: true })

    expect(visible(SUB)).toBe(true)
    expect(visible(DEEP)).toBe(true)
  })

  it('钉住一个目录后：祖先链可见，但兄弟分支不出现', () => {
    const visible = createChildVisibility([ROOT], { [DEEP]: true })

    // 祖先链：根 -> SUB（否则 DEEP 挂不到树上）
    expect(visible(ROOT)).toBe(true)
    expect(visible(SUB)).toBe(true)
    // 焦点自己
    expect(visible(DEEP)).toBe(true)
    // 不在焦点里的一支**整个**让位：它自己不出现，子项也不展开
    // （「只看这一支」的语义 —— 留着旁边那一行的目录名只会让人以为它也能展开）
    expect(visible(OTHER)).toBe(false)
  })

  it('可以同时钉多个分支', () => {
    const visible = createChildVisibility([ROOT], { [SUB]: true, [OTHER]: true })

    expect(visible(SUB)).toBe(true)
    expect(visible(OTHER)).toBe(true)
    expect(visible(DEEP)).toBe(true)
  })

  it('钉住祖先之后，被它盖住的另一个 pin 不再单独作为一个根出现', () => {
    const visible = createChildVisibility([ROOT], { [SUB]: true, [DEEP]: true })

    expect(visible(SUB)).toBe(true)
    // DEEP 在 SUB 里面：它本身已经是 SUB 这一支里的一个节点，
    // 不该再作为一个「根」出现（它的子项仍然跟着 SUB 这一支展开）
    expect(visible(DEEP)).toBe(false)
  })

  it('前缀相同的兄弟目录不会被当成祖先或后代', () => {
    const sibling = 'C:\\Users\\dynas\\Documents\\testing'
    const otherBranch = `${ROOT}\\别的分支`

    // 方向一：钉住 test -> testing 不是它的后代，这一支的子项不该被放开
    expect(createChildVisibility([ROOT], { [ROOT]: true })(sibling)).toBe(false)

    // 方向二：钉住 testing -> test 不是它的祖先链。
    // 但 test 是**树的根**，根永远要能展开（否则整棵树直接消失），所以它仍然可见。
    const pinSibling = createChildVisibility([ROOT], { [sibling]: true })
    expect(pinSibling(ROOT)).toBe(true)
    expect(pinSibling(sibling)).toBe(true)
    // 而 test 底下除「焦点那一支」之外的分支仍然不该展开
    expect(pinSibling(otherBranch)).toBe(false)
  })
})

// ============ 行表构建 ============

describe('buildTreeRows', () => {
  it('**判定为真时根的子项真的会进行表** —— 这是本文件最重要的一条', () => {
    const rows = buildTreeRows(
      input({ children: { '/p': [dir('/p/test'), file('/p/readme.md')] } })
    )

    expect(outline(rows)).toEqual([
      ['p', 0],
      ['test', 1],
      ['readme.md', 1]
    ])
  })

  it('判定为假时该条目整条不渲染（只看某一支：旁边那一支让位）', () => {
    const rows = buildTreeRows(
      input({
        children: {
          '/p': [dir('/p/卷一'), dir('/p/卷二'), file('/p/readme.md')],
          '/p/卷一': [file('/p/卷一/第一章.md')],
          '/p/卷二': [file('/p/卷二/第二章.md')]
        },
        expanded: { '/p': true, '/p/卷一': true, '/p/卷二': true },
        // 只有「卷一」这一支往下走
        isChildVisible: (dirPath) => !dirPath.startsWith('/p/卷二')
      })
    )

    expect(outline(rows)).toEqual([
      ['p', 0],
      ['卷一', 1],
      ['第一章.md', 2],
      ['readme.md', 1]
    ])
  })

  it('门与筛都要有：目录的子项可显示时，里面的**条目**仍要各自过一遍筛', () => {
    // 这是 bug 的第二种形态：只留「门」的话，判定函数对目录返回真就会把整层
    // 原样铺出来，兄弟分支照样出现
    const rows = buildTreeRows(
      input({
        children: { '/p': [dir('/p/keep'), dir('/p/drop')] },
        expanded: { '/p': true },
        isChildVisible: (dirPath) => dirPath !== '/p/drop'
      })
    )

    expect(outline(rows)).toEqual([
      ['p', 0],
      ['keep', 1]
    ])
  })

  it('根永远在行表里，即使它的子项还没读回来', () => {
    const rows = buildTreeRows(input({ children: {}, loading: { '/p': true } }))

    expect(outline(rows)).toEqual([['p', 0]])
    expect(rows[1]).toMatchObject({ kind: 'note', tone: 'muted', text: 'loading', depth: 1 })
  })

  it('根收起时不走它的子项', () => {
    const rows = buildTreeRows(
      input({ children: { '/p': [dir('/p/test')] }, expanded: { '/p': false } })
    )

    expect(outline(rows)).toEqual([['p', 0]])
  })

  it('展开状态缺失时当作展开：根默认收起会让整棵树看起来是空的', () => {
    const rows = buildTreeRows(input({ children: { '/p': [file('/p/a.md')] }, expanded: {} }))

    expect(outline(rows)).toEqual([
      ['p', 0],
      ['a.md', 1]
    ])
  })

  it('空目录不单列一行说明，而是把那一行标成「空」', () => {
    const rows = buildTreeRows(input({ children: { '/p': [] } }))

    // 根那一行永远不算空：连根都不给展开，整棵树就没有入口了
    expect(rows[0]).toMatchObject({ kind: 'entry', empty: false })
    // 根是空的，所以它下面不再有「这个文件夹是空的」那一行
    expect(rows).toHaveLength(1)
  })

  it('读过、里面是空的子目录标成 empty，界面上据此不画展开箭头', () => {
    const rows = buildTreeRows(
      input({
        children: {
          '/p': [dir('/p/空'), dir('/p/满')],
          '/p/空': [],
          '/p/满': [file('/p/满/a.md')]
        },
        // 满那一支要展开，它的子项才会进行表 —— 那样才检查得到「文件永远不算空」
        expanded: { '/p': true, '/p/满': true }
      })
    )

    const byName = new Map(
      rows
        .filter((row): row is Extract<TreeRow, { kind: 'entry' }> => row.kind === 'entry')
        .map((row) => [row.entry.name, row.empty])
    )

    expect(byName.get('空')).toBe(true)
    expect(byName.get('满')).toBe(false)
    // 文件永远不算「空」：这个标记只对目录有意义
    expect(byName.get('a.md')).toBe(false)
  })

  it('还没读过的目录不算空 —— 否则它的展开箭头会在读到之前先消失', () => {
    const rows = buildTreeRows(
      input({ children: { '/p': [dir('/p/未读')] }, expanded: { '/p': true } })
    )

    const unread = rows.find((row) => row.kind === 'entry' && row.entry.name === '未读') as Extract<
      TreeRow,
      { kind: 'entry' }
    >

    expect(unread.empty).toBe(false)
  })

  it('读失败的目录不算空：它下面是自己那一行错误', () => {
    const rows = buildTreeRows(
      input({
        // 读不出来时 store 不会写 children 项，只记一条 errors —— 照这个真实形状造数据
        children: { '/p': [dir('/p/broken')] },
        errors: { '/p/broken': 'unreadable' },
        expanded: { '/p': true, '/p/broken': true }
      })
    )

    const broken = rows.find(
      (row) => row.kind === 'entry' && row.entry.name === 'broken'
    ) as Extract<TreeRow, { kind: 'entry' }>

    expect(broken.empty).toBe(false)
    // 展开箭头还得在：用户要能收起那条错误行
    expect(rows.some((row) => row.kind === 'note' && row.tone === 'error')).toBe(true)
  })

  it('读失败的目录给一行错误，并且不再往下走', () => {
    const rows = buildTreeRows(
      input({
        children: { '/p': [dir('/p/broken')] },
        errors: { '/p/broken': 'unreadable' },
        expanded: { '/p': true, '/p/broken': true }
      })
    )

    expect(rows[2]).toMatchObject({ kind: 'note', tone: 'error', text: 'error:unreadable' })
  })

  it('展开的目录把自己的子项按层级铺在下面', () => {
    const rows = buildTreeRows(
      input({
        children: {
          '/p': [dir('/p/卷一'), file('/p/readme.md')],
          '/p/卷一': [file('/p/卷一/第一章.md')]
        },
        expanded: { '/p': true, '/p/卷一': true }
      })
    )

    expect(outline(rows)).toEqual([
      ['p', 0],
      ['卷一', 1],
      ['第一章.md', 2],
      ['readme.md', 1]
    ])
  })

  it('缩进辅助线只在有兄弟时延续，最后一项不再画线', () => {
    const rows = buildTreeRows(
      input({
        children: {
          '/p': [dir('/p/卷一'), dir('/p/卷二')],
          '/p/卷一': [file('/p/卷一/a.md'), file('/p/卷一/b.md')]
        },
        expanded: { '/p': true, '/p/卷一': true }
      })
    )

    expect(guidesOf(rows, 'p')).toEqual([])
    expect(guidesOf(rows, '卷一')).toEqual([])
    expect(guidesOf(rows, '卷二')).toEqual([])
    expect(guidesOf(rows, 'a.md')).toEqual([true])
    expect(guidesOf(rows, 'b.md')).toEqual([true])
  })

  it('「最后一项」按**可见**兄弟算：被挡掉的不算在后面', () => {
    const rows = buildTreeRows(
      input({
        children: { '/p': [dir('/p/卷一'), dir('/p/卷二')], '/p/卷一': [file('/p/卷一/a.md')] },
        expanded: { '/p': true, '/p/卷一': true },
        isChildVisible: (dirPath) => dirPath !== '/p/卷二'
      })
    )

    // 卷二被挡掉，卷一成了最后一个可见兄弟 -> 它下面的竖线不该再延续
    expect(guidesOf(rows, 'a.md')).toEqual([false])
  })

  it('多个根按传入顺序依次铺开', () => {
    const rows = buildTreeRows(
      input({
        roots: ['/p', '/tmp/nide'],
        children: { '/p': [file('/p/a.md')], '/tmp/nide': [file('/tmp/nide/scratch.md')] },
        expanded: { '/p': true, '/tmp/nide': true }
      })
    )

    expect(outline(rows)).toEqual([
      ['p', 0],
      ['a.md', 1],
      ['nide', 0],
      ['scratch.md', 1]
    ])
  })

  it('没有根时给空行表（调用方据此显示加载中）', () => {
    expect(buildTreeRows(input({ roots: [], children: {} }))).toEqual([])
  })
})

// ============ 端到端：真实判定 + 行表 ============

describe('buildTreeRows 与真实可见性判定合起来跑', () => {
  it('没有钉目录时根的子项必须出现 —— 真实 bug 的回归用例', () => {
    const rows = buildTreeRows(
      input({
        roots: [ROOT],
        children: {
          [ROOT]: [dir(SUB), file(`${ROOT}\\readme.md`)],
          [SUB]: [dir(DEEP)]
        },
        expanded: { [ROOT]: true, [SUB]: true },
        isChildVisible: createChildVisibility([ROOT], {})
      })
    )

    expect(outline(rows)).toEqual([
      ['test', 0],
      ['新建文件夹', 1],
      ['卷一', 2],
      ['readme.md', 1]
    ])
  })

  it('钉住「卷一」之后，兄弟分支整条让位（不在焦点里的那一支不出现）', () => {
    const rows = buildTreeRows(
      input({
        roots: [ROOT],
        children: {
          [ROOT]: [dir(SUB), dir(OTHER)],
          [SUB]: [dir(DEEP)],
          [DEEP]: [file(`${DEEP}\\第一章.md`)],
          [OTHER]: [file(`${OTHER}\\别的.md`)]
        },
        expanded: { [ROOT]: true, [SUB]: true, [DEEP]: true, [OTHER]: true },
        isChildVisible: createChildVisibility([ROOT], { [DEEP]: true })
      })
    )

    expect(outline(rows)).toEqual([
      ['test', 0],
      ['新建文件夹', 1],
      ['卷一', 2],
      ['第一章.md', 3]
    ])
    // 「别的分支」自己与它下面的文件都不在行表里
    expect(rows.filter((row) => row.kind === 'entry' && row.entry.name === '别的分支')).toEqual([])
  })
})

describe('treeBaseName', () => {
  it('取最后一段，两种分隔符都认', () => {
    expect(treeBaseName('D:\\Novel\\卷一')).toBe('卷一')
    expect(treeBaseName('/home/me/novel')).toBe('novel')
  })

  it('末尾有分隔符时也不会给空名字', () => {
    expect(treeBaseName('/home/me/novel/')).toBe('novel')
  })
})
