import { describe, expect, it, vi } from 'vitest'
import {
  buildEntryMenu,
  createScopeOf,
  isProjectRoot,
  withViewItems,
  type EntryActionHandlers,
  type EntryActionTarget,
  type EntryMenuContext
} from '@nide/client-ui-main/entry/entry-menu'
import type {
  ContextMenuEntry,
  ContextMenuItem,
  ContextSubmenuItem
} from '@nide/client-kit/ui/menu-items'
import type { Translator } from '@nide/contracts/i18n'

/**
 * 条目动作层里那一半「判断」的测试：什么目标得到哪些项、哪一项该置灰。
 *
 * 这一层刻意写成纯函数（处理器是注入的），所以这里不需要渲染、不需要 zustand、
 * 也不需要 electron。真正落盘的那一半在主进程，由 test/main/services 下的用例覆盖。
 */

/** 项目根。菜单里「根不能删」这条判断要拿它比对 */
const PROJECT_ROOT = 'D:\\Novel'

/**
 * 一个测试用的词条函数：原样返回 key。
 *
 * 这样断言里写的 `host.explorer.menu.delete` 既是在断言「用的是哪一条词条」，
 * 也顺带证明了**没有**拼错的 key —— 换成真词条表反而看不出用的是哪一条。
 */
const t: Translator = (key) => key

function target(path: string, kind: EntryActionTarget['kind'] = 'directory'): EntryActionTarget {
  return { path, name: path.split(/[\\/]/).filter(Boolean).pop() ?? path, kind }
}

function setup(roots: readonly string[] = [PROJECT_ROOT]): {
  handlers: EntryActionHandlers
  context: EntryMenuContext
} {
  const handlers: EntryActionHandlers = {
    create: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn()
  }

  return { handlers, context: { roots, t, handlers } }
}

/** 取出一个普通行。取不到就直接抛：后面的断言才有意义 */
function rowOf(items: ContextMenuEntry[], id: string): ContextMenuItem {
  const found = items.find((item) => item.id === id)
  if (!found || 'items' in found) throw new Error(`no menu row: ${id}`)
  return found
}

/** 取出一个子菜单行。子菜单项没有 onSelect，点它是展开而不是执行 */
function submenuOf(items: ContextMenuEntry[], id: string): ContextSubmenuItem {
  const found = items.find((item) => item.id === id)
  if (!found || !('items' in found)) throw new Error(`no submenu: ${id}`)
  return found
}

describe('新建落点', () => {
  it('右键目录 -> 建在它内部', () => {
    expect(createScopeOf(target('D:\\Novel\\卷一', 'directory'))).toBe('inside')
  })

  it('右键文件 -> 建在它的同级', () => {
    expect(createScopeOf(target('D:\\Novel\\第一章.md', 'file'))).toBe('sibling')
  })
})

describe('项目根的判断', () => {
  it('路径就是根时成立，末尾分隔符与大小写都不影响', () => {
    expect(isProjectRoot(target(PROJECT_ROOT), [PROJECT_ROOT])).toBe(true)
    expect(isProjectRoot(target('d:\\novel\\'), [PROJECT_ROOT])).toBe(true)
  })

  it('根里面的条目不是根', () => {
    expect(isProjectRoot(target('D:\\Novel\\卷一'), [PROJECT_ROOT])).toBe(false)
  })

  it('名字以根开头的兄弟目录不是根', () => {
    // 逐段比较而不是 startsWith：D:\Novel2 不是 D:\Novel 的根
    expect(isProjectRoot(target('D:\\Novel2'), [PROJECT_ROOT])).toBe(false)
  })

  it('还没有根（树没加载出来）时不认任何东西是根', () => {
    expect(isProjectRoot(target(PROJECT_ROOT), [])).toBe(false)
  })
})

describe('共用的条目菜单项', () => {
  it('三项，顺序是新建 / 重命名 / 删除', () => {
    const { context } = setup()
    const items = buildEntryMenu(target('D:\\Novel\\第一章.md', 'file'), context)

    expect(items.map((item) => item.id)).toEqual(['new', 'rename', 'delete'])
  })

  it('「新建」是子菜单，展开是文件夹 / 文件，自己不带动作', () => {
    const { context } = setup()
    const submenu = submenuOf(
      buildEntryMenu(target('D:\\Novel\\卷一', 'directory'), context),
      'new'
    )

    expect(submenu.label).toBe('host.explorer.menu.new')
    expect(submenu.items.map((item) => item.id)).toEqual(['newFolder', 'newFile'])
  })

  it('子菜单把「文件夹 / 文件」连同被右键的目标交回 create', () => {
    const { handlers, context } = setup()
    const entry = target('D:\\Novel\\卷一', 'directory')
    const submenu = submenuOf(buildEntryMenu(entry, context), 'new')

    submenu.items[0].onSelect()
    submenu.items[1].onSelect()

    expect(handlers.create).toHaveBeenNthCalledWith(1, 'directory', entry)
    expect(handlers.create).toHaveBeenNthCalledWith(2, 'file', entry)
  })

  it('重命名与删除把目标交回各自的处理器', () => {
    const { handlers, context } = setup()
    const entry = target('D:\\Novel\\第一章.md', 'file')
    const items = buildEntryMenu(entry, context)

    rowOf(items, 'rename').onSelect()
    rowOf(items, 'delete').onSelect()

    expect(handlers.rename).toHaveBeenCalledWith(entry)
    expect(handlers.remove).toHaveBeenCalledWith(entry)
  })

  it('删除是 danger 配色：它是这一列里唯一不可撤销的一项', () => {
    const { context } = setup()
    const items = buildEntryMenu(target('D:\\Novel\\第一章.md', 'file'), context)

    expect(rowOf(items, 'delete').danger).toBe(true)
  })

  it('目标是项目根时删除置灰，并写明原因', () => {
    const { context } = setup()
    const remove = rowOf(buildEntryMenu(target(PROJECT_ROOT, 'directory'), context), 'delete')

    expect(remove.disabled).toBe(true)
    expect(remove.disabledReason).toBe('host.explorer.delete.failed.is-project-root')
  })

  it('目标不是根时删除可点', () => {
    const { context } = setup()
    const remove = rowOf(buildEntryMenu(target('D:\\Novel\\卷一', 'directory'), context), 'delete')

    expect(remove.disabled).toBeUndefined()
  })
})

describe('视图自己的项', () => {
  it('排在共用块之前 —— 否则会插到「删除」后面', () => {
    const shared: ContextMenuEntry[] = [{ id: 'delete', label: '删除', onSelect: () => {} }]
    const view: ContextMenuEntry[] = [{ id: 'newChapter', label: '新建章节', onSelect: () => {} }]

    expect(withViewItems(shared, view).map((item) => item.id)).toEqual(['newChapter', 'delete'])
  })

  it('没有视图项时原样返回共用块', () => {
    const shared: ContextMenuEntry[] = [{ id: 'delete', label: '删除', onSelect: () => {} }]

    expect(withViewItems(shared)).toBe(shared)
    expect(withViewItems(shared, [])).toBe(shared)
  })
})
