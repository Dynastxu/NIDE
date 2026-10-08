import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { normalizeLocale } from '@shared/i18n'
import type { LocaleId } from '@shared/i18n'

/**
 * 语言偏好的持久化。
 *
 * 刻意**不**走渲染进程的 localStorage：主进程在开窗之前就要知道用哪个语言
 * （窗口标题、原生菜单都是主进程渲染的），而 localStorage 在渲染进程里，
 * 主进程读不到。放在 userData 下，两端都能等到同一个答案。
 */

const FILE_NAME = 'locale.json'

function filePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

export function readPreferredLocale(): LocaleId | null {
  try {
    const raw = fs.readFileSync(filePath(), 'utf-8')
    const parsed = JSON.parse(raw) as { locale?: unknown }
    if (typeof parsed.locale !== 'string' || parsed.locale.length === 0) return null
    return normalizeLocale(parsed.locale)
  } catch {
    // 文件不存在 / 内容坏了都走这条：没偏好不是错误，回落到系统语言即可
    return null
  }
}

export function writePreferredLocale(locale: LocaleId): void {
  const target = filePath()
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${JSON.stringify({ locale }, null, 2)}\n`, 'utf-8')
  } catch (err) {
    // 写不进去只影响「下次启动还记得」，不该让切语言整体失败
    console.error('[i18n] 写入语言偏好失败', err)
  }
}
