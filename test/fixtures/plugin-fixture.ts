import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 在系统临时目录里造插件夹具。
 *
 * 刻意不写进仓库：这些夹具要造出**坏目录** —— 穿越路径、坏 JSON、缺字段 ——
 * 放进仓库既脏，又容易被误当成真插件被宿主扫到。
 */
export interface PluginFixture {
  /** 临时根目录的绝对路径 */
  readonly root: string
  /** 往 root 下写文件（相对路径），自动建父目录；返回绝对路径 */
  write(relativePath: string, content: unknown): string
  /** 建一个插件目录并写入 manifest.json，返回 **manifest.json** 的绝对路径 */
  plugin(name: string, manifest: unknown): string
  /** 删掉整个临时根目录 */
  remove(): void
}

export function createPluginFixture(): PluginFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nide-i18n-test-'))

  const write = (relativePath: string, content: unknown): string => {
    const full = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
    return full
  }

  return {
    root,
    write,
    plugin: (name, manifest) => write(path.join(name, 'manifest.json'), manifest),
    remove: () => fs.rmSync(root, { recursive: true, force: true })
  }
}

/** 最小 manifest 外壳：只贡献语言包，没有 views —— 语言包本来就是纯数据插件 */
export function manifestShell(id: string): { id: string; name: string; version: string } {
  return { id, name: id, version: '1.0.0' }
}

/**
 * 造一个「贡献语言包」的 manifest。
 *
 * `label` 省略时故意不写进对象，用来覆盖「label 缺失回落成 locale 本身」那条路径。
 */
export function localeManifest(
  id: string,
  locale: string,
  file = 'locales/x.json',
  label?: string
): unknown {
  return {
    ...manifestShell(id),
    contributes: {
      locales: [{ locale, ...(label === undefined ? {} : { label }), file }]
    }
  }
}
