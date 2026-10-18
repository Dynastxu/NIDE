import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readProjectForeshadowing,
  type RootsOptions
} from '../../../src/main/services/project-files.service'

/**
 * 伏笔列表的**读盘**部分。
 *
 * 这一段只有真的文件系统给得出结论：四个字段写在整份 yml 里（`data` 底下，见
 * shared/project/foreshadowing），而这一步要把整份文件读出来 —— 描述可能很长，
 * 列表要显示完整的起止章节与描述。用例因此重点撞这几个地方：四个字段都读得出、
 * 读不出的仍然列出来、名称回落到文件名、非 yml 不参与、以及读不了目录时给原因而
 * 不是抛异常。
 */

let root = ''
const windows = process.platform === 'win32'

function options(overrides: Partial<RootsOptions> = {}): RootsOptions {
  return { roots: [root], caseInsensitive: windows, ...overrides }
}

async function writeFile(relativePath: string, content: string): Promise<string> {
  const full = path.join(root, relativePath)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content, 'utf-8')
  return full
}

/** 一份伏笔 yml。用例只关心这四个字段，其余键写不写都不影响这一步 */
function entry(fields: {
  name?: string
  startChapter?: string
  endChapter?: string
  description?: string
}): string {
  const lines = ['category: foreshadowing', 'data:']

  if (fields.name !== undefined) lines.push(`  name: "${fields.name}"`)
  if (fields.startChapter !== undefined) {
    lines.push(`  startChapter: "${fields.startChapter}"`)
  }
  if (fields.endChapter !== undefined) lines.push(`  endChapter: "${fields.endChapter}"`)
  if (fields.description !== undefined) lines.push(`  description: "${fields.description}"`)

  return `${lines.join('\n')}\n`
}

beforeEach(async () => {
  // realpath：macOS 的 /var 是 /private/var 的链接，不解析的话范围校验会判错
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nide-foreshadowing-')))
  root = path.join(base, 'project')
  await fs.mkdir(path.join(root, 'foreshadowing'), { recursive: true })
})

afterEach(async () => {
  await fs.rm(path.dirname(root), { recursive: true, force: true })
})

describe('readProjectForeshadowing', () => {
  it('读出四个字段，顺序与目录排序一致', async () => {
    await writeFile(
      'foreshadowing/a.yml',
      entry({
        name: '主角的身世',
        startChapter: '003',
        endChapter: '012',
        description: '第一章埋下的玉佩'
      })
    )
    await writeFile(
      'foreshadowing/b.yaml',
      entry({ name: '反派的动机', startChapter: '005', endChapter: '020' })
    )

    const result = await readProjectForeshadowing(path.join(root, 'foreshadowing'), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(
      result.foreshadowing.map((file) => [
        file.name,
        file.label,
        file.startChapter,
        file.endChapter,
        file.description
      ])
    ).toEqual([
      ['a.yml', '主角的身世', '003', '012', '第一章埋下的玉佩'],
      ['b.yaml', '反派的动机', '005', '020', '']
    ])
  })

  it('没有类别的 yml 仍然列出来：名称回落到文件名，其余字段为空', async () => {
    await writeFile('foreshadowing/还没想好.yml', 'note: 一些设想\n')

    const result = await readProjectForeshadowing(path.join(root, 'foreshadowing'), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.foreshadowing).toHaveLength(1)
    expect(result.foreshadowing[0]).toMatchObject({
      name: '还没想好.yml',
      label: '还没想好',
      startChapter: '',
      endChapter: '',
      description: ''
    })
  })

  it('非 yml 不参与伏笔列表', async () => {
    await writeFile('foreshadowing/a.yml', entry({ name: '一条伏笔' }))
    await writeFile('foreshadowing/notes.md', '# 随笔\n')
    await writeFile('foreshadowing/notes.txt', '随笔')

    const result = await readProjectForeshadowing(path.join(root, 'foreshadowing'), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.foreshadowing.map((file) => file.name)).toEqual(['a.yml'])
  })

  it('描述很长时整份文件都被读到，不会被截断', async () => {
    const description = '很长的描述'.repeat(4000)
    await writeFile('foreshadowing/long.yml', entry({ name: '很长的一条伏笔', description }))

    const result = await readProjectForeshadowing(path.join(root, 'foreshadowing'), options())

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.foreshadowing[0]?.description).toBe(description)
  })

  it('目录不存在时给带原因的结果，而不是抛异常', async () => {
    const result = await readProjectForeshadowing(path.join(root, 'nope'), options())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('not-a-directory')
  })

  it('目录在项目之外时拒绝', async () => {
    const result = await readProjectForeshadowing(path.dirname(root), options())

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('outside-project')
  })
})
