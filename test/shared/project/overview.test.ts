import { describe, expect, it } from 'vitest'
import { OVERVIEW_ROLES, PROJECT_OVERVIEW_CHANNELS } from '@nide/contracts/project'

/**
 * 概述的纯逻辑：角色集合与通道名。
 *
 * 大纲 / 写作风格只是 `.nide/config.yml` 里的两个可选文件名；解析与校验属于项目配置
 * （见 project-config.test.ts），列表与标记的落盘在 main/services 的测试里。
 */

describe('概述的标记', () => {
  it('只有大纲与写作风格两个角色', () => {
    expect([...OVERVIEW_ROLES]).toEqual(['outline', 'style'])
  })

  it('通道名带 host: 前缀', () => {
    expect(PROJECT_OVERVIEW_CHANNELS.readOverview).toBe('host:project-read-overview')
    expect(PROJECT_OVERVIEW_CHANNELS.setRole).toBe('host:project-set-overview-role')
  })
})
