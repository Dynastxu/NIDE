import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

const globalEnv = globalThis as unknown as {
  MonacoEnvironment?: { getWorker?: () => Worker }
}

globalEnv.MonacoEnvironment = {
  getWorker: () => new EditorWorker()
}
