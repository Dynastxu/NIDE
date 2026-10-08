import { JSX, Suspense, lazy, useCallback, useState, type LazyExoticComponent } from 'react'
import { SettingsTreeNav } from '@renderer/settings/SettingsTreeNav'
import { SettingsIndexPage } from '@renderer/settings/SettingsIndexPage'
import { findNode, firstPageNodeId } from '@renderer/settings/tree-utils'
import { RestartDialog } from '@renderer/settings/RestartDialog'
import {
  SETTINGS_PAGES,
  SETTINGS_TREE,
  type SettingsPageId,
  type SettingsPageProps
} from '@renderer/settings/pages'
import { useT } from '@renderer/stores/i18n.store'
import { WindowFrame } from '@renderer/window/WindowFrame'

/**
 * 「全局设置」窗口。
 *
 * 只做一件事：把设置界面包进共用的窗口骨架（自定义标题栏）—— 和主窗口
 * （MainApp）是同一个形状。设置界面自己不知道标题栏的存在。
 *
 * **刻意不传 actions**：标题栏上那颗「设置」按钮属于主窗口。在设置窗口里再放
 * 一颗是个循环入口（点它只会把自己聚焦一次）。复用的是窗口骨架，不是主窗口
 * 那一条标题栏的内容。
 *
 * 这里曾经漏掉过 WindowFrame —— 因为设置界面是从「内容直接挂到 root」的写法
 * 演进过来的，包骨架那一步被漏了，表现就是「设置页面的标题栏没了」。所以下面
 * 这个划分是刻意的：这一层只有窗口装配，界面在 SettingsWindowContent 里。
 */
export function SettingsApp(): JSX.Element {
  const t = useT()

  return (
    <WindowFrame title={t('host.settings.title')}>
      <SettingsWindowContent />
    </WindowFrame>
  )
}

/**
 * 设置界面的本体：左树 + 右页 + 右下角按钮条。
 *
 * ## 选中与渲染的关系
 *
 * 树里选中的永远是**节点**（父项、子项都能选）。右侧渲染什么由节点决定：
 * - 节点登记了页面 -> 渲染那个页面
 * - 没登记页面 -> 渲染**默认页**（一列指向它子设置的链接）
 * - 还有子节点 -> 页面下面再跟一组子设置链接。否则父节点一旦有了自己的页面，
 *   它的子节点就再也进不去了（树上虽然看得见，但树可以收起）
 *
 * ## 草稿归页面，按钮条只管发号施令
 *
 * 页面自己攒未应用的改动（草稿是每页各自的形状），通过 props 交上来三件事：
 * 报告「脏不脏」、注册「提交 / 丢弃」、报告「这次提交有没有动到需要重启的插件」。
 * 这一层不认识任何具体设置项，所以加一页设置不用动这个文件。
 *
 * ## 关于「确定 / 取消 / 应用」，要说清现在**真实**的行为
 *
 * - 「应用」「确定」= 提交当前页的草稿；「取消」= 丢弃当前页草稿并关窗。
 * - 切页等于丢弃上一页草稿（用户已经看不见它了，不该留在背后）。
 * - **语言是例外**：它没有草稿可用 —— 换语言要重建整个窗口，而这个设置窗口
 *   本身就在被重建之列。所以点语言即刻生效，取消不回去。这是宿主既有机制
 *   （切语言必须重建窗口）决定的，不是偷懒。
 */
function SettingsWindowContent(): JSX.Element {
  const t = useT()
  /** 默认停在第一个**有页面**的设置项上（跳过只有子设置的容器节点） */
  const [selectedId, setSelectedId] = useState<string>(() => firstNodeId())
  const [dirty, setDirty] = useState(false)
  /** 页面交上来的「提交 / 丢弃」。切页时被新页面覆盖 */
  const [actions, setActions] = useState<{
    commit: (() => void) | null
    reset: (() => void) | null
  }>({ commit: null, reset: null })
  /** 「立即重启」提示。true 表示有一个待用户回答的问题挂着 */
  const [askRestart, setAskRestart] = useState(false)

  const selected = findNode(SETTINGS_TREE, selectedId)

  /**
   * 交给页面的三个回调必须是**引用稳定**的。
   *
   * 这不是优化，是正确性：页面会在 effect 里调用 registerActions，如果这个函数
   * 每次渲染都是新的，effect 就会重跑 -> setActions 换一个新对象 -> 再渲染 ->
   * 又是新函数……直接变成无限渲染。setDirty / setAskRestart 是 useState 的 setter
   * （引用天然稳定），只有 registerActions 需要自己包一层。
   */
  const registerActions = useCallback((commit: (() => void) | null, reset: (() => void) | null) => {
    setActions({ commit, reset })
  }, [])

  const onDirtyChange = useCallback((next: boolean) => setDirty(next), [])
  const onRestartRequired = useCallback(() => setAskRestart(true), [])

  const pageProps: SettingsPageProps = {
    onDirtyChange,
    registerActions,
    onRestartRequired
  }

  const commit = (): void => {
    actions.commit?.()
  }

  const close = (): void => window.hostAPI.window.action('close')

  const Page = selected?.page ? PAGE_COMPONENTS[selected.page] : null

  return (
    <div className="relative flex h-full w-full flex-col bg-zinc-900 text-zinc-200">
      <div className="flex min-h-0 flex-1">
        <SettingsTreeNav selectedId={selectedId} onSelect={setSelectedId} />

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {!selected ? (
            <p className="p-6 text-xs text-zinc-500">{t('host.settings.index.empty')}</p>
          ) : (
            <>
              {Page ? (
                <Suspense
                  fallback={<p className="p-6 text-xs text-zinc-500">{t('host.plugin.loading')}</p>}
                >
                  {/* key 绑节点 id：换页时页面重新挂载，草稿自然归零 */}
                  <Page key={selected.id} {...pageProps} />
                </Suspense>
              ) : (
                <SettingsIndexPage node={selected} onNavigate={setSelectedId} />
              )}

              {/* 有页面的父节点也要给子设置留入口，否则它们只存在于可收起的树里 */}
              {Page && (selected.children?.length ?? 0) > 0 && (
                <SettingsIndexPage node={selected} onNavigate={setSelectedId} />
              )}
            </>
          )}
        </div>
      </div>

      {/* 按钮条：右对齐，贴着内容区右下角 */}
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-zinc-800 bg-zinc-950/40 px-4 py-2.5">
        <FooterButton
          label={t('host.settings.apply.ok')}
          variant="primary"
          // 没有改动时「确定」就是「关闭」—— 仍然可点，用户不该被迫先改点什么
          onClick={() => {
            commit()
            close()
          }}
        />
        <FooterButton
          label={t('host.settings.apply.cancel')}
          onClick={() => {
            actions.reset?.()
            close()
          }}
        />
        <FooterButton label={t('host.settings.apply.apply')} disabled={!dirty} onClick={commit} />
      </footer>

      {askRestart && (
        <RestartDialog
          onRestart={() => window.hostAPI.window.restart()}
          onLater={() => setAskRestart(false)}
        />
      )}
    </div>
  )
}

/** 设置窗口打开时的落点：树里第一个有页面的节点 */
function firstNodeId(): string {
  const id = firstPageNodeId(SETTINGS_TREE)
  if (!id) throw new Error('设置树是空的')
  return id
}

/** 每种设置页的懒加载组件，模块顶层建一次（理由见 registerActions 的注释） */
const PAGE_COMPONENTS: Record<
  SettingsPageId,
  LazyExoticComponent<(p: SettingsPageProps) => JSX.Element>
> = {
  language: lazy(SETTINGS_PAGES.language),
  plugins: lazy(SETTINGS_PAGES.plugins)
}

function FooterButton({
  label,
  onClick,
  variant = 'default',
  disabled = false
}: {
  label: string
  onClick: () => void
  variant?: 'default' | 'primary'
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        'rounded px-3.5 py-1 text-xs transition-colors',
        disabled
          ? 'cursor-not-allowed bg-zinc-800/50 text-zinc-600'
          : variant === 'primary'
            ? 'bg-blue-600 text-white hover:bg-blue-500'
            : 'bg-zinc-700 text-zinc-100 hover:bg-zinc-600'
      ].join(' ')}
    >
      {label}
    </button>
  )
}
