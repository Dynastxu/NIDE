import { localeCandidates } from '@shared/i18n'
import type { LocaleId, MessageTable } from '@shared/i18n'

/**
 * 插件的 **manifest 文案**本地化。
 *
 * 和语言包是两件不同的事，别混：
 * - 语言包（language-packs.ts）翻的是**宿主自己**的文案。
 * - 这里翻的是**插件自己**的 manifest 文案（视图标题等），数据在插件目录里。
 *
 * 约定照抄 VS Code：manifest 里写 `%key%` 占位符，插件目录下放
 *   package.nls.json          插件自己声明的默认语言
 *   package.nls.<locale>.json 某个语言的翻译
 * 只有**整串**被 % 包住才算占位符，所以 "100% done" 这种标题不会被误判。
 */

/** 默认词条文件名（插件自己声明的语言） */
export const DEFAULT_NLS_FILE = 'package.nls.json'

/** `package.nls.<locale>.json` 的文件名规则 */
export const NLS_FILE_RE = /^package\.nls\.(.+)\.json$/

/** 一个插件贡献的全部 manifest 词条 */
export interface ManifestNlsTables {
  /** package.nls.json：插件自己声明的默认语言，最后一档回落 */
  defaultTable?: MessageTable
  /** locale -> package.nls.<locale>.json */
  byLocale: Record<LocaleId, MessageTable>
}

const PLACEHOLDER_RE = /^%(.+)%$/

/** 只在整串被 % 包住时才算占位符 */
export function parsePlaceholder(spec: string): string | null {
  const match = PLACEHOLDER_RE.exec(spec)
  return match ? match[1] : null
}

/** pluginId -> 该插件的 manifest 词条 */
export class ManifestNlsRegistry {
  private tables = new Map<string, ManifestNlsTables>()

  register(pluginId: string, tables: ManifestNlsTables): void {
    this.tables.set(pluginId, tables)
  }

  /** 清空。主要给测试用，和 LanguagePackRegistry.reset() 保持对称 */
  reset(): void {
    this.tables.clear()
  }

  unregisterByPlugin(pluginId: string): void {
    this.tables.delete(pluginId)
  }

  get(pluginId: string): ManifestNlsTables | undefined {
    return this.tables.get(pluginId)
  }

  /**
   * 把 manifest 里的一个值解析成当前语言下的文案。
   *
   * 解析链：精确 locale -> 放宽的 locale（en-US 命中 en）-> 插件默认表 -> 原样返回。
   *
   * 最后一档刻意返回**原样的 `%key%`**：漏翻会显眼地出现在界面上，
   * 而不是静默变成空字符串或别人的语言。和宿主 t() 的做法一致。
   */
  resolve(pluginId: string, spec: string | undefined, locale: LocaleId): string | undefined {
    if (spec === undefined) return undefined

    const key = parsePlaceholder(spec)
    // 不是占位符就是普通字符串，原样用（老插件不用改 manifest 也能正常工作）
    if (key === null) return spec

    const tables = this.tables.get(pluginId)
    if (!tables) return spec

    // localeCandidates 已经做过规范化，byLocale 的 key 由 loader 保证也是规范形式
    for (const candidate of localeCandidates(locale)) {
      const value = tables.byLocale[candidate]?.[key]
      if (value !== undefined) return value
    }

    return tables.defaultTable?.[key] ?? spec
  }
}

export const manifestNlsRegistry = new ManifestNlsRegistry()
