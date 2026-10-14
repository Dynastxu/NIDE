import * as monaco from 'monaco-editor'

/**
 * 打开过的文件的 Monaco model 登记表。
 *
 * 从 EditorTabs 里单独拆出来，是因为**正文的所有权不在组件上**：
 *
 * - 编辑器组件会在标签页归零时卸载（见 EditorTabs 的「没有打开任何文件时不建编辑器」），
 *   挂在组件内部的缓存在那一刻就没了，而「打开过的文件」比组件活得久；
 * - 保存要用到同一份正文 —— 它不能只认编辑器实例，否则「标签条上的保存」与
 *   「编辑器里的 Ctrl+S」会各自去取一遍值，迟早不一致。
 *
 * 生命周期只跟随 store 里的 `tabs`：标签页被关掉时释放（见 releaseClosedModels），
 * 窗口重建时随渲染进程一起消失。同一时刻只有一个窗口能用到它：这个模块属于主窗口的
 * 渲染进程。
 */
const MODEL_CACHE = new Map<string, monaco.editor.ITextModel>()

/**
 * model -> 它属于哪个标签页（路径）。
 *
 * **必须自己记，不能反推 `model.uri.path`。** `Uri.file('C:\\a\\b.md')` 在 Windows 上
 * 得到的是 `/c:/a/b.md` —— 反斜杠被换成斜杠、盘符被小写 —— 而标签页的路径是主进程
 * 用 `path.join` 给的 `C:\a\b.md`。两者不是同一个字符串，于是「用户在打字」这件事会被
 * 记到一个 store 里查不到的路径上：dirty 永远算不出来，圆点永远不亮，关标签也不会问
 * 那一句。macOS / Linux 上两者恰好一样（都以 `/` 分段），所以这个错只在 Windows 上现形。
 *
 * 用 WeakMap 而不是普通 Map：键是 model 自己，它被 dispose 之后条目跟着消失，
 * 不需要在释放那一侧再维护第二份对应关系。
 */
const PATH_BY_MODEL = new WeakMap<monaco.editor.ITextModel, string>()

/** 这个路径的 model；没建过（或者已经释放）时给 null */
export function modelFor(filePath: string): monaco.editor.ITextModel | null {
  return MODEL_CACHE.get(filePath) ?? null
}

/** 这个 model 属于哪个标签页；不是这里建出来的 model 时给 null */
export function pathOfModel(model: monaco.editor.ITextModel): string | null {
  return PATH_BY_MODEL.get(model) ?? null
}

/**
 * 取这个文件的 model，没有就按给定内容与语言建一个。
 *
 * 建的时候用的必须是**与磁盘一致的那一份**（tab.originalValue）：它是撤销历史的起点，
 * 也是「改了没有」的比较基准。
 */
export function ensureModel(tab: {
  path: string
  language: string
  originalValue: string
}): monaco.editor.ITextModel {
  const existing = MODEL_CACHE.get(tab.path)
  if (existing) return existing

  const model = monaco.editor.createModel(
    tab.originalValue,
    tab.language,
    monaco.Uri.file(tab.path)
  )
  MODEL_CACHE.set(tab.path, model)
  PATH_BY_MODEL.set(model, tab.path)
  return model
}

/** 关掉标签页时释放它的 model，否则改一次文件、关一次，model 会一直攒着 */
export function releaseClosedModels(openPaths: ReadonlySet<string>): void {
  for (const [path, model] of MODEL_CACHE) {
    if (openPaths.has(path)) continue
    model.dispose()
    MODEL_CACHE.delete(path)
  }
}

/**
 * 把一份内容写进 model，并且**不让这次写入被当成用户的编辑**。
 *
 * 用 `pushEditOperations` 而不是 `setValue`：前者保留撤销历史（宿主改过之后
 * 用户还能 Ctrl+Z 退回去），后者会把历史清空。
 *
 * `syncing` 是指向调用方那个 ref 的引用 —— 写入期间把它置成 true，
 * `onDidChangeModelContent` 据此跳过 setDocument，否则「写入 -> 算 dirty ->
 * 又写回 store」会绕成环，把刚刚设好的基准立刻推翻。
 */
export function writeModelSilently(
  model: monaco.editor.ITextModel,
  content: string,
  syncing: { current: boolean }
): void {
  syncing.current = true
  try {
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: content }], () => null)
  } finally {
    syncing.current = false
  }
}
