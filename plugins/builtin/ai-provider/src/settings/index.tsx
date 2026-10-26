import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import { usePluginTranslator } from '@nide/sdk/plugin-views/host-context'
import type { SettingsPageProps } from '@nide/client-ui-settings/pages'
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  type ModelInfo,
  type ProviderSummary,
  type ReasoningEffort,
  type ThinkingMode
} from '@nide/contracts/ai-provider'
import type { MessageTable } from '@nide/contracts/i18n'

/**
 * 插件自己的词条表。
 *
 * 设置页标题由 manifest 的 package.nls 解析（宿主只负责标题），页面正文归插件
 * 自己 —— 和 demo 插件同一套约定。第一个 key 是默认语言，作为兜底。
 */
const MESSAGES: Record<string, MessageTable> = {
  'zh-CN': {
    title: 'AI 供应商',
    description:
      'API Key 由系统安全存储加密后保存在本机，只用于向供应商发起请求；页面不会回填已保存的 Key。',
    add: '新建供应商',
    notConfigured: '未配置 Key',
    defaultBadge: '默认',
    name: '名称',
    baseURL: 'Base URL',
    apiKey: 'API Key',
    keySaved: '已保存。留空表示保持不变；修改 Base URL 时必须重新输入。',
    keyHint: 'Key 只在保存时写入系统加密存储，不会回显。',
    model: '模型',
    thinking: '思考模式',
    thinkingOn: '开启',
    thinkingOff: '关闭',
    effort: '思考强度',
    test: '测试连接',
    testing: '测试中…',
    testOk: '连接成功，发现 {count} 个模型',
    testFailed: '测试连接失败',
    save: '保存',
    saving: '保存中…',
    saved: '已保存',
    remove: '删除供应商',
    confirmRemove: '再点一次确认删除',
    removed: '已删除',
    loading: '正在读取供应商…',
    empty: '还没有配置供应商。点「新建供应商」开始。',
    contextWindow: '上下文 {tokens}',
    unavailable: '系统安全存储不可用，无法保存 API Key。'
  },
  en: {
    title: 'AI Providers',
    description:
      'The API key is encrypted with the OS secure storage and only used for provider requests. Saved keys are never shown again.',
    add: 'New provider',
    notConfigured: 'No key',
    defaultBadge: 'Default',
    name: 'Name',
    baseURL: 'Base URL',
    apiKey: 'API Key',
    keySaved: 'Saved. Leave empty to keep it; changing the Base URL requires re-entering it.',
    keyHint: 'The key is written to OS secure storage only on save and never displayed.',
    model: 'Model',
    thinking: 'Thinking',
    thinkingOn: 'Enabled',
    thinkingOff: 'Disabled',
    effort: 'Effort',
    test: 'Test connection',
    testing: 'Testing…',
    testOk: 'Connected, {count} models found',
    testFailed: 'Connection test failed',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved',
    remove: 'Remove provider',
    confirmRemove: 'Click again to confirm',
    removed: 'Removed',
    loading: 'Loading providers…',
    empty: 'No provider configured yet. Use “New provider” to start.',
    contextWindow: '{tokens} context',
    unavailable: 'OS secure storage is unavailable; the API key cannot be saved.'
  }
}

interface Draft {
  name: string
  baseURL: string
  model: string
  apiKey: string
  thinking: ThinkingMode
  reasoningEffort: ReasoningEffort
}

function emptyDraft(): Draft {
  return {
    name: 'DeepSeek',
    baseURL: DEFAULT_DEEPSEEK_BASE_URL,
    model: DEFAULT_DEEPSEEK_MODEL,
    apiKey: '',
    thinking: 'enabled',
    reasoningEffort: 'high'
  }
}

function toDraft(provider: ProviderSummary): Draft {
  return {
    name: provider.name,
    baseURL: provider.baseURL,
    model: provider.model,
    apiKey: '',
    thinking: provider.thinking,
    reasoningEffort: provider.reasoningEffort
  }
}

type Busy = 'loading' | 'saving' | 'testing' | 'removing' | null

async function loadProviders(): Promise<ProviderSummary[]> {
  return window.hostAPI.aiProvider.list()
}

/**
 * AI 供应商设置页。
 *
 * 这一页只出现在「设置 -> 插件 -> AI 供应商」，没有视图入口。它是插件贡献的
 * settings 页面，拿到的是宿主统一的 SettingsPageProps（脏标记、提交/丢弃），
 * 所以底部「确定 / 取消 / 应用」的行为和宿主自己的页面一致。
 *
 * 所有密钥操作都是单向的：页面把明文交给主进程，主进程加密落盘；列表/测试的
 * 返回值里只有 `configured: boolean`，没有 Key，也没有可以反推 Key 的信息。
 */
export default function AiProviderSettings({
  onDirtyChange,
  registerActions
}: SettingsPageProps): JSX.Element {
  const t = usePluginTranslator(MESSAGES)
  const [providers, setProviders] = useState<ProviderSummary[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<Busy>('loading')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const selected = useMemo(
    () => providers?.find((provider) => provider.id === selectedId) ?? null,
    [providers, selectedId]
  )

  const applyProviders = useCallback((list: ProviderSummary[]) => {
    setProviders(list)

    const first = list.find((provider) => provider.default) ?? list[0] ?? null
    setSelectedId(first?.id ?? null)
    setDraft(first ? toDraft(first) : emptyDraft())
    setModels(first?.models ?? [])
    setDirty(false)
    setConfirmRemove(false)
  }, [])

  const reload = useCallback(async () => {
    try {
      applyProviders(await loadProviders())
    } catch (err) {
      setProviders((prev) => prev ?? [])
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [applyProviders])

  /**
   * 首次加载。
   *
   * 刻意不在 effect 里直接调 `reload()`：那个函数会同步 setState，
   * react-hooks 的 set-state-in-effect 规则会报错。这里先 await，再在 then
   * 回调里落状态，语义一样，但不会触发级联渲染。
   */
  useEffect(() => {
    let cancelled = false

    void loadProviders()
      .then((list) => {
        if (!cancelled) applyProviders(list)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          // 读不到列表也要把页面从 loading 里放出来，错误才有地方显示
          setProviders((prev) => prev ?? [])
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) setBusy(null)
      })

    return () => {
      cancelled = true
    }
  }, [applyProviders])

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  const update = (patch: Partial<Draft>): void => {
    setDraft((prev) => ({ ...prev, ...patch }))
    // 地址一换，旧模型的上下文窗口/可用列表就不再成立，先清空避免存错
    if (patch.baseURL !== undefined) setModels([])
    setDirty(true)
    setConfirmRemove(false)
    setError(null)
    setNotice(null)
  }

  const selectProvider = (provider: ProviderSummary): void => {
    setSelectedId(provider.id)
    setDraft(toDraft(provider))
    setModels(provider.models)
    setDirty(false)
    setError(null)
    setNotice(null)
    setConfirmRemove(false)
  }

  const newProvider = (): void => {
    setSelectedId(null)
    setDraft(emptyDraft())
    setModels([])
    setDirty(false)
    setError(null)
    setNotice(null)
    setConfirmRemove(false)
  }

  const save = useCallback(async (): Promise<boolean> => {
    if (busy === 'saving') return false

    setBusy('saving')
    setError(null)
    setNotice(null)

    try {
      const result = await window.hostAPI.aiProvider.save({
        ...(selectedId ? { id: selectedId } : {}),
        name: draft.name,
        baseURL: draft.baseURL,
        model: draft.model,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        ...(models.length > 0 ? { models } : {}),
        thinking: draft.thinking,
        reasoningEffort: draft.reasoningEffort
      })

      if (!result.ok) {
        setError(result.error.message)
        return false
      }

      setSelectedId(result.provider.id)
      setDraft(toDraft(result.provider))
      setModels(result.provider.models)
      // 先把返回的这条并进列表：即使后面的 list 刷新失败，选中项也不会突然消失
      setProviders((prev) => {
        const list = prev ?? []
        const exists = list.some((provider) => provider.id === result.provider.id)
        return exists
          ? list.map((provider) =>
              provider.id === result.provider.id ? result.provider : provider
            )
          : [...list, result.provider]
      })
      setDirty(false)
      setNotice(t('saved'))

      // 列表刷新失败不该把“保存成功”改写成失败：provider 已经落盘了
      try {
        setProviders(await window.hostAPI.aiProvider.list())
      } catch {
        // ignore
      }
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(null)
    }
  }, [busy, draft, models, selectedId, t])

  const runTest = useCallback(async (): Promise<void> => {
    if (busy === 'testing') return

    setBusy('testing')
    setError(null)
    setNotice(null)

    try {
      const result = await window.hostAPI.aiProvider.test({
        ...(selectedId ? { providerId: selectedId } : {}),
        baseURL: draft.baseURL,
        ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {})
      })

      if (!result.ok || !result.models) {
        setError(result.error?.message ?? t('testFailed'))
        return
      }

      setModels(result.models)
      setNotice(t('testOk', { count: result.models.length }))

      // 当前模型不在新列表里（比如换了地址/账号）时，落到第一个可用模型上
      if (!result.models.some((model) => model.id === draft.model)) {
        const first = result.models[0]?.id
        if (first) {
          setDraft((prev) => ({ ...prev, model: first }))
          setDirty(true)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [busy, draft.baseURL, draft.apiKey, draft.model, selectedId, t])

  const remove = useCallback(async (): Promise<void> => {
    if (!selectedId) return

    // 两步确认：删除是不可撤销的（Key 也一起删），但没必要为它开系统对话框
    if (!confirmRemove) {
      setConfirmRemove(true)
      return
    }

    setBusy('removing')
    setError(null)
    try {
      const result = await window.hostAPI.aiProvider.remove(selectedId)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      await reload()
      setNotice(t('removed'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }, [confirmRemove, reload, selectedId, t])

  /**
   * 注册给底部按钮的提交动作。
   *
   * `save` 会随草稿变化换引用，所以这里每次草稿变化都重新注册一次。父级的
   * setActions 只是换一份引用，不会再反过来改草稿，不存在循环。
   */
  useEffect(() => {
    registerActions(
      () => save(),
      () => {
        setError(null)
        setNotice(null)
        void reload()
      }
    )
    return () => registerActions(null, null)
  }, [registerActions, reload, save])

  const modelOptions = useMemo(() => {
    const list = models
    if (list.some((model) => model.id === draft.model)) return list
    return [{ id: draft.model, name: draft.model }, ...list]
  }, [draft.model, models])

  const disabled = busy !== null && busy !== 'loading'
  const canTest = draft.apiKey.trim().length > 0 || selected?.configured === true

  if (providers === null) {
    return <p className="p-6 text-xs text-zinc-500">{t('loading')}</p>
  }

  return (
    <section className="flex max-w-3xl flex-col gap-5 p-6">
      <header>
        <h2 className="text-sm font-medium text-zinc-100">{t('title')}</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-500">{t('description')}</p>
      </header>

      <div className="flex flex-wrap gap-2">
        {providers.map((provider) => {
          const active = provider.id === selectedId
          return (
            <button
              key={provider.id}
              type="button"
              onClick={() => selectProvider(provider)}
              className={[
                'flex min-w-40 flex-col items-start gap-0.5 rounded border px-3 py-2 text-left transition-colors',
                active
                  ? 'border-blue-500 bg-blue-600/15 text-zinc-100'
                  : 'border-zinc-700 bg-zinc-900/40 text-zinc-300 hover:border-zinc-600 hover:bg-zinc-800/60'
              ].join(' ')}
            >
              <span className="text-xs font-medium">
                {provider.name}
                {provider.default && (
                  <span className="ml-1.5 text-[10px] font-normal text-blue-400">
                    {t('defaultBadge')}
                  </span>
                )}
              </span>
              <span className="text-[10px] text-zinc-500">
                {provider.configured ? provider.model : t('notConfigured')}
              </span>
            </button>
          )
        })}

        <button
          type="button"
          onClick={newProvider}
          className="flex min-w-32 items-center justify-center rounded border border-dashed border-zinc-700 px-3 py-2 text-xs text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
        >
          + {t('add')}
        </button>
      </div>

      {providers.length === 0 && <p className="text-xs text-zinc-500">{t('empty')}</p>}

      <div className="flex flex-col gap-3 rounded border border-zinc-800 bg-zinc-950/40 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('name')}>
            <input
              value={draft.name}
              onChange={(event) => update({ name: event.target.value })}
              className={inputClass}
              spellCheck={false}
            />
          </Field>

          <Field label={t('baseURL')}>
            <input
              value={draft.baseURL}
              onChange={(event) => update({ baseURL: event.target.value })}
              className={inputClass}
              spellCheck={false}
            />
          </Field>
        </div>

        <Field label={t('apiKey')}>
          <input
            type="password"
            value={draft.apiKey}
            onChange={(event) => update({ apiKey: event.target.value })}
            placeholder={selected?.configured ? '••••••••' : 'sk-...'}
            className={inputClass}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
        <p className="-mt-2 text-[11px] text-zinc-500">
          {selected?.configured ? t('keySaved') : t('keyHint')}
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('model')}>
            <div className="flex gap-2">
              <select
                value={draft.model}
                onChange={(event) => update({ model: event.target.value })}
                className={`${inputClass} min-w-0 flex-1`}
              >
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name ? `${model.name} (${model.id})` : model.id}
                    {model.contextWindow
                      ? ` · ${t('contextWindow', { tokens: formatTokens(model.contextWindow) })}`
                      : ''}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  void runTest()
                }}
                disabled={disabled || !canTest}
                className={secondaryButtonClass}
              >
                {busy === 'testing' ? t('testing') : t('test')}
              </button>
            </div>
          </Field>

          <Field label={t('thinking')}>
            <select
              value={draft.thinking}
              onChange={(event) => update({ thinking: event.target.value as ThinkingMode })}
              className={inputClass}
            >
              <option value="enabled">{t('thinkingOn')}</option>
              <option value="disabled">{t('thinkingOff')}</option>
            </select>
          </Field>
        </div>

        <Field label={t('effort')}>
          <select
            value={draft.reasoningEffort}
            onChange={(event) => update({ reasoningEffort: event.target.value as ReasoningEffort })}
            disabled={draft.thinking === 'disabled'}
            className={`${inputClass} max-w-48 disabled:cursor-not-allowed disabled:opacity-50`}
          >
            <option value="low">low</option>
            <option value="high">high</option>
            <option value="max">max</option>
          </select>
        </Field>

        {error && <p className="text-xs text-red-400">{error}</p>}
        {notice && <p className="text-xs text-emerald-400">{notice}</p>}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => {
              void save()
            }}
            disabled={disabled}
            className="rounded bg-blue-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === 'saving' ? t('saving') : t('save')}
          </button>

          {selectedId && (
            <button
              type="button"
              onClick={() => {
                void remove()
              }}
              disabled={disabled}
              className={[
                'rounded border px-3 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                confirmRemove
                  ? 'border-red-500 bg-red-600/20 text-red-300 hover:bg-red-600/30'
                  : 'border-zinc-700 text-zinc-400 hover:border-red-500/60 hover:text-red-300'
              ].join(' ')}
            >
              {confirmRemove ? t('confirmRemove') : t('remove')}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

const inputClass =
  'w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-200 outline-none transition-colors focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-50'

const secondaryButtonClass =
  'shrink-0 rounded border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50'

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[11px] text-zinc-400">{label}</span>
      {children}
    </div>
  )
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}
