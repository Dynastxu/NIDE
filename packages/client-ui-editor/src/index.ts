import type { Context } from 'cordis'
import { registerCommand } from '@nide/client-kit/commands'
import { slotsOf } from '@nide/client-ui-slots'
import { EditorTabs } from './EditorTabs'
import { MonacoDiffView } from './MonacoDiffView'
import { saveActiveTab } from './shared/editor-save'

/**
 * 编辑器功能包的 client 插件。
 *
 * 它负责三块：
 *
 * 1. 主窗口中间区（`main.editor` slot）——标签条、Monaco、章节 / 图鉴表单；
 * 2. 窗口级 `shell.overlay` 上的 diff 浮层（AI 提议修改时出现）；
 * 3. `editor.save` 命令：菜单「文件 -> 保存」通过 client-kit 的命令表调用，
 *    窗口因此不需要 import 编辑器实现。
 *
 * 文档状态在 `client-kit/stores/documents.store`；Monaco 的正文归本包的
 * `shared/model-registry`。两者不互相 import 对方的实现。
 */
export const editorPlugin = {
  name: 'nide-client-ui-editor',
  inject: ['slots'],

  apply(ctx: Context): void {
    const slots = slotsOf(ctx)

    ctx.effect(() => slots.register('main.editor', EditorTabs), 'main.editor')

    ctx.effect(
      () => slots.register({ name: 'shell.overlay', order: 10 }, MonacoDiffView),
      'shell.overlay editor'
    )

    ctx.effect(() => registerCommand('editor.save', () => saveActiveTab()), 'command editor.save')

    ctx.logger('client-ui-editor').info('editor view + diff overlay + save command registered')
  }
}

/** 花名册协议：client-runtime 按 windowTypes 过滤后挂载这里列出的插件 */
export const clientPlugins = [editorPlugin]
