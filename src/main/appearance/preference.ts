import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { DEFAULT_APPEARANCE, normalizeAppearancePreference } from '@shared/appearance'
import { loggerFor } from '../logger'
import type { AppearancePreference } from '@shared/appearance'

const logger = loggerFor('appearance')

/**
 * 主题偏好的持久化。
 *
 * 和语言偏好（host 的 `services/i18n.ts`）同一个理由、同一个位置：**主进程在开窗之前就要
 * 知道用什么主题**（窗口底色、原生菜单与对话框的明暗），而 localStorage 在渲染进程里，
 * 主进程读不到。放在 userData 下，两端都能等到同一个答案。
 *
 * 刻意不合并进语言的那份 JSON：它们是两件事，各坏各的时候不该互相牵连 ——
 * 主题文件写坏顶多回到默认配色，不该让语言偏好一起回默认。
 */

const FILE_NAME = 'appearance.json'

function filePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

/** 读偏好。文件不存在或内容坏掉都不是错误，回落到默认值 */
export function readPreferredAppearance(): AppearancePreference {
  try {
    const raw = fs.readFileSync(filePath(), 'utf-8')
    return normalizeAppearancePreference(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_APPEARANCE }
  }
}

export function writePreferredAppearance(preference: AppearancePreference): void {
  const target = filePath()
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify(preference, null, 2)}\n`, 'utf-8')
  } catch (err) {
    // 写不进去只影响「下次启动还记得」，不该让这次切换整体失败：
    // 本次的界面已经按新主题渲染过了
    logger.error('Failed to write the appearance preference', { error: err })
  }
}
