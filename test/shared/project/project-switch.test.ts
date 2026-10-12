import { describe, expect, it } from 'vitest'
import { isProjectSwitch } from '@shared/project'

/**
 * 「这次打开会不会丢掉一个已经打开的项目」。
 *
 * 这个判据决定**换项目那一问要不要弹**，所以两侧都错不得：放宽了会在欢迎窗口
 * 里平白问一句（打开项目本来就不是破坏性动作），收紧了则会在重建窗口之前不问 ——
 * 用户的未保存内容就这么没了。
 */
describe('isProjectSwitch', () => {
  it('没有当前项目时不算换项目（从欢迎窗口打开）', () => {
    expect(isProjectSwitch(null, 'D:\\Novel', true)).toBe(false)
    expect(isProjectSwitch(undefined, 'D:\\Novel', true)).toBe(false)
    expect(isProjectSwitch('', 'D:\\Novel', true)).toBe(false)
  })

  it('打开的就是当前项目时不算换项目（重复打开，什么都没发生）', () => {
    expect(isProjectSwitch('D:\\Novel', 'D:\\Novel', true)).toBe(false)
    expect(isProjectSwitch('/home/me/novel', '/home/me/novel', false)).toBe(false)
  })

  it('打开的是另一个项目就算换项目', () => {
    expect(isProjectSwitch('D:\\Novel', 'D:\\Other', true)).toBe(true)
    expect(isProjectSwitch('/home/me/novel', '/home/me/other', false)).toBe(true)
  })

  it('末尾分隔符与大小写按调用方给的那套规则折算', () => {
    // Windows 的路径不区分大小写：同一个目录换个写法不该被问一次
    expect(isProjectSwitch('D:\\Novel', 'd:\\novel\\', true)).toBe(false)
    expect(isProjectSwitch('D:\\Novel', 'D:\\Novel\\', true)).toBe(false)
    // 大小写敏感的平台（Linux）上，那是两个目录
    expect(isProjectSwitch('/home/me/novel', '/home/me/Novel', false)).toBe(true)
  })

  it('前缀相同的兄弟目录不会被当成同一个项目', () => {
    expect(isProjectSwitch('D:\\Novel', 'D:\\Novel2', true)).toBe(true)
  })
})
