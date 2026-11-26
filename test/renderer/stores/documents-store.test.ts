import { beforeEach, describe, expect, it } from 'vitest'
import { useDocumentsStore } from '@nide/client-kit/stores/documents.store'

/**
 * 文档状态（从 editor.store 移到 client-kit 之后）。
 *
 * 这一层只做纯状态：打开哪些文件、当前看哪一个、脏标记、关闭队列。Monaco 的正文
 * 不在这里（见 model-registry），所以这些用例不需要 DOM / 编辑器。
 *
 * 搬家的目的只是让 explorer / 未来的 editor 包都依赖 client-kit，而不是互相 import；
 * 行为必须与搬之前一致 —— 这里钉住最容易在搬家时被顺手改掉的几条。
 */
function reset(): void {
  useDocumentsStore.setState({
    tabs: [],
    activePath: null,
    pendingDiff: null,
    closeQueue: []
  })
}

describe('documents store', () => {
  beforeEach(reset)

  it('打开文件：建标签页并激活，初始不脏', () => {
    useDocumentsStore.getState().openFile({
      path: '/n/ch1.md',
      name: 'ch1.md',
      language: 'markdown',
      content: 'hello'
    })

    const state = useDocumentsStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.activePath).toBe('/n/ch1.md')
    expect(state.tabs[0]).toMatchObject({
      path: '/n/ch1.md',
      name: 'ch1.md',
      language: 'markdown',
      content: 'hello',
      originalValue: 'hello',
      dirty: false,
      refreshToken: 0
    })
  })

  it('重复打开同一路径：不新增标签页，基准换成磁盘版本并推进 refreshToken', () => {
    const store = useDocumentsStore.getState()
    store.openFile({ path: '/n/ch1.md', name: 'ch1.md', language: 'markdown', content: 'v1' })
    store.setDocument('/n/ch1.md', 'edited')
    expect(useDocumentsStore.getState().tabs[0].dirty).toBe(true)

    store.openFile({ path: '/n/ch1.md', name: 'ch1.md', language: 'markdown', content: 'v2' })

    const state = useDocumentsStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toMatchObject({
      originalValue: 'v2',
      content: 'v2',
      dirty: false,
      refreshToken: 1
    })
  })

  it('setDocument：正文变化才更新并重算脏标记', () => {
    const store = useDocumentsStore.getState()
    store.openFile({ path: '/n/ch1.md', name: 'ch1.md', language: 'markdown', content: 'v1' })

    const before = useDocumentsStore.getState().tabs
    store.setDocument('/n/ch1.md', 'v1')
    expect(useDocumentsStore.getState().tabs).toBe(before)

    store.setDocument('/n/ch1.md', 'v2')
    expect(useDocumentsStore.getState().tabs[0]).toMatchObject({ content: 'v2', dirty: true })
  })

  it('syncFromDisk：刷新基准但不动当前标签页', () => {
    const store = useDocumentsStore.getState()
    store.openFile({ path: '/n/a.md', name: 'a.md', language: 'markdown', content: 'a' })
    store.openFile({ path: '/n/b.md', name: 'b.md', language: 'markdown', content: 'b' })
    store.setActive('/n/a.md')

    expect(store.syncFromDisk('/n/b.md', 'b2')).toBe(true)

    const state = useDocumentsStore.getState()
    expect(state.activePath).toBe('/n/a.md')
    expect(state.tabs.find((tab) => tab.path === '/n/b.md')).toMatchObject({
      originalValue: 'b2',
      content: 'b2',
      dirty: false
    })
    expect(store.syncFromDisk('/n/missing.md', 'x')).toBe(false)
  })

  it('migratePath：标签页与当前路径一起改名，语言跟着扩展名走', () => {
    const store = useDocumentsStore.getState()
    store.openFile({ path: '/n/a.txt', name: 'a.txt', language: 'plaintext', content: 'a' })

    expect(store.migratePath('/n/a.txt', '/n/a.md')).toBe(true)

    const state = useDocumentsStore.getState()
    expect(state.tabs[0]).toMatchObject({ path: '/n/a.md', name: 'a.md', language: 'markdown' })
    expect(state.activePath).toBe('/n/a.md')
    expect(store.migratePath('/n/missing.txt', '/n/x.md')).toBe(false)
  })

  it('关闭：干净的立即关；脏的先入队，finishClose 才真正关', () => {
    const store = useDocumentsStore.getState()
    store.openFile({ path: '/n/a.md', name: 'a.md', language: 'markdown', content: 'a' })

    store.requestClose('/n/a.md')
    expect(useDocumentsStore.getState().tabs).toHaveLength(0)

    store.openFile({ path: '/n/b.md', name: 'b.md', language: 'markdown', content: 'b' })
    store.setDocument('/n/b.md', 'b!')
    store.requestClose('/n/b.md')

    expect(useDocumentsStore.getState().tabs).toHaveLength(1)
    expect(useDocumentsStore.getState().closeQueue).toEqual(['/n/b.md'])

    store.finishClose()
    expect(useDocumentsStore.getState().tabs).toHaveLength(0)
    expect(useDocumentsStore.getState().closeQueue).toEqual([])
  })
})
