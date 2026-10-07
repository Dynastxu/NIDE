import { JSX, useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import loader from '@monaco-editor/loader'
import { useEditorStore } from '../stores/editor.store'

export function MonacoEditor(): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)

  const { setCurrentContent, setCurrentFile } = useEditorStore()

  // 初始化 Monaco
  useEffect(() => {
    if (!containerRef.current) return

    loader.config({ monaco })
    let disposed = false

    loader.init().then((monacoInstance) => {
      if (disposed || !containerRef.current) return

      const editor = monacoInstance.editor.create(containerRef.current, {
        value: '',
        language: 'plaintext',
        theme: 'vs-dark',
        minimap: { enabled: false },
        fontSize: 14,
        automaticLayout: true
      })

      editorRef.current = editor

      // 内容变化时同步到 store
      editor.onDidChangeModelContent(() => {
        setCurrentContent(editor.getValue())
      })
    })

    return () => {
      disposed = true
      editorRef.current?.dispose()
      editorRef.current = null
    }
  }, [setCurrentContent])

  // 监听宿主通知的文件变化（AI 插件写入后）
  useEffect(() => {
    const d = window.hostAPI.onFileChanged((filePath, content) => {
      const editor = editorRef.current
      if (!editor) return

      const model = editor.getModel()
      if (model && model.uri.path === filePath) {
        model.setValue(content)
      }
      setCurrentFile(filePath)
    })

    return () => d.dispose()
  }, [setCurrentFile])

  // 监听 Diff 展示请求
  useEffect(() => {
    const d = window.hostAPI.onShowDiff((original, modified) => {
      useEditorStore.getState().showDiff(original, modified)
    })
    return () => d.dispose()
  }, [])

  return <div ref={containerRef} className="w-full h-full" />
}
