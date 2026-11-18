import { JSX } from 'react'
import { useT } from '@nide/client-kit/stores/i18n.store'
import type { SettingsNode } from '@nide/client-ui-settings/pages'

/**
 * 默认设置页 —— **没有定义页面的设置项**点开时显示的内容。
 *
 * 不是「未实现」的占位，而是一列指向子设置的链接：父设置自己没有页面可看，
 * 那它能做的事就是把人送到子设置去。点一下等于在树里点那个子项。
 *
 * 子节点为空时给一句说明而不是空白页 —— 空白页会让人以为是加载失败。
 */
export function SettingsIndexPage({
  node,
  onNavigate
}: {
  node: SettingsNode
  onNavigate: (nodeId: string) => void
}): JSX.Element {
  const t = useT()
  const children = node.children ?? []

  return (
    <section className="flex flex-col gap-3 p-6">
      <h2 className="text-sm font-medium text-fg">{node.label}</h2>

      {children.length === 0 ? (
        <p className="text-xs text-fg-subtle">{t('host.settings.index.empty')}</p>
      ) : (
        <ul className="flex max-w-md flex-col gap-1">
          {children.map((child) => (
            <li key={child.id}>
              <button
                type="button"
                onClick={() => onNavigate(child.id)}
                className="flex w-full items-center justify-between rounded border border-line px-3 py-2 text-left text-xs text-fg transition-colors hover:border-line-strong hover:bg-subtle"
              >
                {/* 子设置自己的页面名（而不是它在树上的标签）—— 和树上看到的措辞一致 */}
                <span>{child.label}</span>
                <span aria-hidden="true" className="text-fg-subtle">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
