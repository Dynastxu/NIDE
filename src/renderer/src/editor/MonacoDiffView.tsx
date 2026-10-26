import { JSX, useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import { monacoLoader } from '@renderer/monaco-env'
import { useEditorStore } from '@nide/client-kit/stores/editor.store'
import { useT } from '@nide/client-kit/stores/i18n.store'

export function MonacoDiffView(): JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null)
  const diffRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  const { pendingDiff, clearDiff } = useEditorStore()
  const t = useT()

  useEffect(() => {
    if (!pendingDiff || !containerRef.current) return

    let disposed = false

    /**
     * 走 monacoLoader() 而不是直接 import loader：那一层已经把它指向打包进来的 monaco
     * （见 monaco-env）。自己 import 会绕开那次配置，退回加载 CDN —— 而 CSP 不允许。
     */
    monacoLoader()
      .init()
      .then((monacoInstance) => {
        if (disposed || !containerRef.current) return

        const diff = monacoInstance.editor.createDiffEditor(containerRef.current, {
          renderSideBySide: true,
          ignoreTrimWhitespace: true,
          readOnly: true
        })

        const originalModel = monacoInstance.editor.createModel(pendingDiff.original, 'plaintext')
        const modifiedModel = monacoInstance.editor.createModel(pendingDiff.modified, 'plaintext')

        diff.setModel({ original: originalModel, modified: modifiedModel })
        diffRef.current = diff
      })

    return () => {
      disposed = true
      diffRef.current?.dispose()
      diffRef.current = null
    }
  }, [pendingDiff])

  if (!pendingDiff) return null

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-zinc-900 w-[90%] h-[80%] rounded shadow-xl flex flex-col">
        <div className="flex items-center justify-between p-3 border-b border-zinc-700">
          <span className="text-sm">{t('host.diff.title')}</span>
          <button onClick={clearDiff} className="text-xs px-2 py-1 bg-zinc-700 rounded">
            {t('host.diff.close')}
          </button>
        </div>
        <div ref={containerRef} className="flex-1" />
      </div>
    </div>
  )
}
