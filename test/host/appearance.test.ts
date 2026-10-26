import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostAppearance } from '../../packages/services/appearance/src/appearance.ts'

/**
 * 主题 / 外观（host 侧）。
 *
 * 这一块从 shell 搬过来（原来在 `packages/shell/src/main/appearance`），行为逐条保留：偏好文件、
 * 「认不出来的主题只回落不写盘」、`fallbackFrom` 的语义、切换时的校验。
 *
 * `nativeTheme` 那一下走反向桥（`shell.call`），独立运行时桥没挂 —— 这里的用例正好
 * 覆盖「桥不可用只记日志、业务照常」这条降级路径。
 */

let base = ''
let userDataDir = ''

function service(): HostAppearance {
  return new HostAppearance({ userDataDir })
}

async function writePreference(value: unknown): Promise<void> {
  await fs.writeFile(
    path.join(userDataDir, 'appearance.json'),
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf-8'
  )
}

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'nide-appearance-'))
  userDataDir = path.join(base, 'user-data')
  await fs.mkdir(userDataDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

describe('HostAppearance：启动', () => {
  it('没有偏好文件时用默认深色，可选列表是内置的两套', async () => {
    const state = await service().init()

    expect(state.preference).toEqual({ theme: 'builtin.dark', followSystem: false })
    expect(state.payload.theme).toBe('builtin.dark')
    expect(state.payload.palette).toBe('dark')
    expect(state.payload.available.map((theme) => theme.id)).toEqual([
      'builtin.dark',
      'builtin.light'
    ])
    expect(state.payload.fallbackFrom).toBeUndefined()
  })

  it('读偏好文件里的主题', async () => {
    await writePreference({ theme: 'builtin.light', followSystem: false })

    const state = await service().init()
    expect(state.payload.theme).toBe('builtin.light')
    expect(state.payload.palette).toBe('light')
  })

  it('偏好里的主题认不出来：内存里回落到默认，且不写盘', async () => {
    await writePreference({ theme: 'gone.theme', followSystem: false })

    const state = await service().init()

    expect(state.payload.theme).toBe('builtin.dark')
    expect(state.payload.palette).toBe('dark')
    // 与搬迁前一致：init 已经在内存里把主题换成默认，所以 payload 里没有 fallbackFrom
    // （那条分支只有「偏好没经过 init 就被读取」时才会走到）
    expect(state.payload.fallbackFrom).toBeUndefined()
    // 只是内存里回落，文件保持用户手改的样子（写盘会替用户"修好"，反而丢线索）
    expect(
      JSON.parse(await fs.readFile(path.join(userDataDir, 'appearance.json'), 'utf-8'))
    ).toEqual({ theme: 'gone.theme', followSystem: false })
  })

  it('坏文件当默认偏好', async () => {
    await writePreference('{ not json')

    expect((await service().init()).payload.theme).toBe('builtin.dark')
  })
})

describe('HostAppearance：切换', () => {
  it('切换合法主题：落盘 + 返回新状态', async () => {
    const appearance = service()
    await appearance.init()

    const next = await appearance.setTheme('builtin.light', false)

    expect(next?.payload.theme).toBe('builtin.light')
    expect(next?.preference).toEqual({ theme: 'builtin.light', followSystem: false })
    expect(
      JSON.parse(await fs.readFile(path.join(userDataDir, 'appearance.json'), 'utf-8'))
    ).toEqual({ theme: 'builtin.light', followSystem: false })
  })

  it('切换不存在的主题：返回 null，偏好不动', async () => {
    const appearance = service()
    await appearance.init()

    expect(await appearance.setTheme('nope.theme', false)).toBeNull()
    await expect(fs.readFile(path.join(userDataDir, 'appearance.json'))).rejects.toThrow()
  })

  it('重启后记得上次选的主题', async () => {
    const first = service()
    await first.init()
    await first.setTheme('builtin.light', false)

    const second = service()
    expect((await second.init()).payload.theme).toBe('builtin.light')
  })
})
