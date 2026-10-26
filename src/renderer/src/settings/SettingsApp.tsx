import {
  JSX,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useState,
  type LazyExoticComponent
} from 'react'
import { SettingsTreeNav } from '@renderer/settings/SettingsTreeNav'
import { SettingsIndexPage } from '@renderer/settings/SettingsIndexPage'
import { findNode, firstPageNodeId } from '@renderer/settings/tree-utils'
import { RestartDialog } from '@renderer/settings/RestartDialog'
import { useSettingsTreeStore } from '@renderer/settings/settings-tree.store'
import { PluginSettingsSlot } from '@renderer/plugins/PluginSettingsSlot'
import {
  SETTINGS_PAGES,
  type HostSettingsPageId,
  type SettingsPageProps
} from '@renderer/settings/pages'
import { useT } from '@nide/client-kit/stores/i18n.store'
import { WindowFrame } from '@nide/client-kit/window/WindowFrame'
import { useWindowTitle } from '@nide/client-kit/window/useWindowTitle'

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
  const title = useWindowTitle()

  return (
    <WindowFrame title={title}>
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
 * - 宿主节点 -> 渲染 SETTINGS_PAGES 里的组件
 * - 插件节点 -> 渲染 PluginSettingsSlot（按 dir/entry 查构建期 glob 表）
 * - 没登记页面 -> 渲染**默认页**（一列指向它子设置的链接）
 * - 还有子节点 -> 页面下面再跟一组子设置链接
 *
 * ## 草稿归页面，按钮条只管发号施令
 *
 * 页面自己攒未应用的改动，通过 props 交上来三件事：报告「脏不脏」、
 * 注册「提交 / 丢弃」、报告「这次提交有没有动到需要重启的插件」。
 * 这一层不认识任何具体设置项，所以加一页设置不用动这个文件。
 *
 * ## 插件设置页的显示条件
 *
 * 主进程在 `host:get-plugin-settings` 里就把**被禁用插件**的页面过滤掉了。
 * 设置窗口这里不做第二次判断：插件禁用后页面直接从树上消失，而不是点开一个
 * 后端已经不存在的页面。
 */
function SettingsWindowContent(): JSX.Element {
  const t = useT()
  const tree = useSettingsTreeStore((s) => s.tree)
  const loaded = useSettingsTreeStore((s) => s.loaded)
  const load = useSettingsTreeStore((s) => s.load)

  /** 用户显式点过的节点。null 表示还没点过，落点由 firstPageNodeId 决定 */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  /** 页面交上来的「提交 / 丢弃」。切页时被新页面覆盖 */
  const [actions, setActions] = useState<{
    commit: (() => boolean | void | Promise<boolean | void>) | null
    reset: (() => void) | null
  }>({ commit: null, reset: null })
  /** 「立即重启」提示。true 表示有一个待用户回答的问题挂着 */
  const [askRestart, setAskRestart] = useState(false)

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])

  /**
   * 插件启用状态变化后重拉树。
   *
   * 设置窗口自己就是改状态的地方：在「插件管理」里禁用一个插件，它贡献的设置页
   * 必须立刻从左边树上消失。主进程广播的是所有窗口，这里只需重新拉一次。
   */
  useEffect(() => {
    const subscription = window.hostAPI.onPluginEnabledChanged(() => {
      void useSettingsTreeStore.getState().reload()
    })
    return () => subscription.dispose()
  }, [])

  /**
   * 选中的节点可能已经不在树里（刚被禁用插件的设置页）。
   * 派生一个有效 id，而不是在 effect 里 setState —— 那会多一帧空内容。
   */
  const effectiveId = selectedId && findNode(tree, selectedId) ? selectedId : firstPageNodeId(tree)
  const selected = effectiveId ? findNode(tree, effectiveId) : null

  /**
   * 交给页面的三个回调必须是**引用稳定**的。
   *
   * 这不是优化，是正确性：页面会在 effect 里调用 registerActions，如果这个函数
   * 每次渲染都是新的，effect 就会重跑 -> setActions 换一个新对象 -> 再渲染 ->
   * 又是新函数……直接变成无限渲染。setDirty / setAskRestart 是 useState 的 setter
   * （引用天然稳定），只有 registerActions 需要自己包一层。
   */
  const registerActions = useCallback(
    (
      commit: (() => boolean | void | Promise<boolean | void>) | null,
      reset: (() => void) | null
    ) => {
      setActions({ commit, reset })
    },
    []
  )

  const onDirtyChange = useCallback((next: boolean) => setDirty(next), [])
  const onRestartRequired = useCallback(() => setAskRestart(true), [])

  const pageProps: SettingsPageProps = {
    onDirtyChange,
    registerActions,
    onRestartRequired
  }

  const commit = (): boolean | void | Promise<boolean | void> => actions.commit?.()

  const close = (): void => window.hostAPI.window.action('close')

  /**
   * 「确定」= 提交当前页草稿，等它完成后再关窗。
   *
   * 设置页的提交可能是异步的（AI 供应商要写盘 / 加密），如果先 close 再等 IPC，
   * 保存失败时窗口已经没了，用户看不到错误。提交返回 `false` 表示失败，不关窗；
   * 同步页面返回 void，照旧立刻关。
   */
  const commitAndClose = (): void => {
    let result: boolean | void | Promise<boolean | void>
    try {
      result = actions.commit?.()
    } catch {
      close()
      return
    }

    if (result && typeof (result as Promise<boolean | void>).then === 'function') {
      void Promise.resolve(result)
        .then((ok) => {
          if (ok !== false) close()
        })
        .catch(() => undefined)
    } else if (result !== false) {
      close()
    }
  }

  const page = selected?.page
  const HostPage = page?.kind === 'host' ? PAGE_COMPONENTS[page.id] : null

  return (
    <div className="relative flex h-full w-full flex-col bg-zinc-900 text-zinc-200">
      <div className="flex min-h-0 flex-1">
        <SettingsTreeNav
          tree={tree}
          selectedId={effectiveId ?? ''}
          onSelect={(id) => setSelectedId(id)}
        />

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {!loaded ? (
            <p className="p-6 text-xs text-zinc-500">{t('host.plugin.loading')}</p>
          ) : !selected ? (
            <p className="p-6 text-xs text-zinc-500">{t('host.settings.index.empty')}</p>
          ) : (
            <>
              {page?.kind === 'host' && HostPage ? (
                <Suspense
                  fallback={<p className="p-6 text-xs text-zinc-500">{t('host.plugin.loading')}</p>}
                >
                  {/* key 绑节点 id：换页时页面重新挂载，草稿自然归零 */}
                  <HostPage key={selected.id} {...pageProps} />
                </Suspense>
              ) : page?.kind === 'plugin' ? (
                <PluginSettingsSlot key={selected.id} descriptor={page.descriptor} {...pageProps} />
              ) : (
                <SettingsIndexPage node={selected} onNavigate={(id) => setSelectedId(id)} />
              )}

              {/* 有页面的父节点也要给子设置留入口，否则它们只存在于可收起的树里 */}
              {page && (selected.children?.length ?? 0) > 0 && (
                <SettingsIndexPage node={selected} onNavigate={(id) => setSelectedId(id)} />
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
          onClick={commitAndClose}
        />
        <FooterButton
          label={t('host.settings.apply.cancel')}
          onClick={() => {
            actions.reset?.()
            close()
          }}
        />
        <FooterButton
          label={t('host.settings.apply.apply')}
          disabled={!dirty}
          onClick={() => {
            void commit()
          }}
        />
      </footer>

      {askRestart && (
        <RestartDialog
          /*
           * `confirm: false` = 「这一问刚才已经问过了」：RestartDialog 问的就是
           * 「要不要现在重启」。不带这个参数的话，主进程还会再问一遍
           * （见 main/confirm.ts 的 restart 规格），用户会怀疑自己刚才点的是什么。
           */
          onRestart={() => window.hostAPI.window.restart({ confirm: false })}
          onLater={() => setAskRestart(false)}
        />
      )}
    </div>
  )
}

/** 每种宿主设置页的懒加载组件，模块顶层建一次（理由见 registerActions 的注释） */
const PAGE_COMPONENTS: Record<
  HostSettingsPageId,
  LazyExoticComponent<(p: SettingsPageProps) => JSX.Element>
> = {
  language: lazy(SETTINGS_PAGES.language),
  appearance: lazy(SETTINGS_PAGES.appearance),
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
