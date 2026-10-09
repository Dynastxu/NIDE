/**
 * 宿主的基础词条表 —— **唯一的事实来源**。
 *
 * 三条约定：
 *
 * 1. 中文是宿主**内建**的，不是语言包。一个语言包都没装时必须有可用的词条表，
 *    否则界面会裸露 key。所以这份表编译进宿主包，是兜底地板。
 * 2. 这份表的 key 集合就是**词条 schema**：语言包多出来的 key 会被报为 extra，
 *    少掉的会被报为 missing（回落成中文）。
 * 3. `as const` 是刻意的：`keyof typeof zhCN` 就是 `t()` 的合法参数类型，
 *    宿主代码里写错 key 是**编译错误**，不需要等运行时才发现。
 *
 * 占位符写成 `{name}`，由 createTranslator 插值。
 *
 * 注意：不要在这里写插件自己的文案。插件的词条归插件，宿主只提供 locale。
 */
export const zhCN = {
  'host.app.title': 'NIDE',

  'host.stripe.tooltip': '右键：显示/隐藏标题',
  'host.stripe.menu.showTitles': '显示工具窗口名称',

  // ---- 窗口（自定义标题栏）----
  'host.window.minimize': '最小化',
  'host.window.maximize': '最大化',
  'host.window.restore': '向下还原',
  'host.window.close': '关闭',

  // ---- 主窗口标题栏的菜单（文件 / 编辑）----
  'host.menu.button': '菜单',
  'host.menu.file': '文件',
  'host.menu.file.closeProject': '关闭项目',
  'host.menu.file.closeProject.confirm.title': '关闭项目',
  'host.menu.file.closeProject.confirm.message':
    '关闭当前项目并回到欢迎窗口？项目会留在「打开过的项目」列表里，下次启动仍然默认打开它。',
  'host.menu.file.quit': '退出',
  'host.menu.file.quit.confirm.title': '退出应用',
  'host.menu.file.quit.confirm.message': '退出会关闭所有窗口。是否继续？',
  'host.menu.edit': '编辑',
  'host.menu.edit.undo': '撤销',
  'host.menu.edit.redo': '重做',
  'host.menu.edit.notImplemented': '尚未实现',

  // ---- 通用确认框 ----
  'host.dialog.cancel': '取消',

  // ---- 主窗口标题栏的项目下拉 ----
  'host.project.selector.label': '项目',
  'host.project.selector.none': '未打开项目',
  'host.project.selector.empty': '没有打开过的项目',

  // ---- 欢迎窗口（没有可用的项目时）----
  'host.welcome.title': '欢迎',
  'host.welcome.nav.title': '欢迎选项',
  'host.welcome.nav.projects': '项目',
  'host.welcome.nav.plugins': '插件',
  'host.welcome.settings': '设置',
  'host.welcome.projects.title': '项目',
  'host.welcome.projects.hint':
    '选择一个文件夹作为项目。宿主会记住打开过的文件夹，下次启动直接进入上次那个项目。',
  'host.welcome.projects.create': '新建项目',
  'host.welcome.projects.open': '打开',
  'host.welcome.projects.empty': '还没有打开过任何文件夹。',
  'host.welcome.projects.empty.hint':
    '用右上角的「新建项目」或「打开」选一个文件夹，它会出现在这个列表里。',
  'host.welcome.projects.missing': '目录不存在',
  'host.welcome.projects.menu.open': '打开',
  'host.welcome.projects.menu.remove': '从列表移除',
  'host.welcome.projects.dialog.open.title': '打开项目文件夹',
  'host.welcome.projects.dialog.create.title': '新建项目文件夹',
  'host.welcome.projects.dialog.button': '选择此文件夹',
  'host.welcome.projects.error.missing': '目录不存在：{path}',
  'host.welcome.projects.error.not-a-directory': '这不是一个文件夹：{path}',

  // ---- 设置 ----
  'host.settings.button': '设置',
  'host.settings.menu.global': '全局设置',
  'host.settings.menu.project': '项目设置',
  'host.settings.title': '设置',
  'host.settings.nav.title': '设置选项',
  'host.settings.page.general': '通用',
  'host.settings.page.language': '语言',
  'host.settings.page.plugins': '插件',
  'host.settings.tree.expand': '展开',
  'host.settings.tree.collapse': '收起',
  'host.settings.index.empty': '这一项下面还没有设置。',
  'host.settings.apply.ok': '确定',
  'host.settings.apply.cancel': '取消',
  'host.settings.apply.apply': '应用',

  // 需要重启的提示
  'host.settings.restart.title': '需要重启',
  'host.settings.restart.message':
    '更改需要重启 IDE 才能完全生效，重启会丢掉编辑器里未保存的内容。是否现在就重启？',
  'host.settings.restart.now': '立即',
  'host.settings.restart.later': '稍后',

  // 设置 -> 语言
  'host.settings.language.description':
    '选择界面语言。切换语言需要重建窗口才能完全生效，编辑器里未保存的内容会丢失。',
  'host.settings.language.current': '当前语言',
  'host.settings.language.restartHint': '切换后窗口会自动重建，需要一点时间。',

  // 设置 -> 插件
  'host.settings.plugins.tab.marketplace': '插件市场',
  'host.settings.plugins.tab.installed': '已安装',
  'host.settings.plugins.marketplace.placeholder': '插件市场：暂未实现。',
  'host.settings.plugins.empty': '没有找到任何插件。',
  'host.settings.plugins.group.builtin': '内置',
  'host.settings.plugins.group.user': '用户安装',
  'host.settings.plugins.enable': '启用',
  'host.settings.plugins.detail.select': '在左侧选择一个插件查看详情。',
  'host.settings.plugins.detail.version': '版本',
  'host.settings.plugins.detail.source': '来源',
  'host.settings.plugins.detail.source.builtin': '内置',
  'host.settings.plugins.detail.source.user': '用户安装',
  'host.settings.plugins.detail.dir': '目录',
  'host.settings.plugins.detail.views': '提供的视图',
  'host.settings.plugins.detail.views.none': '这个插件没有提供任何视图。',
  'host.settings.plugins.detail.permissions': '权限',
  'host.settings.plugins.detail.permissions.none': '无',
  'host.settings.plugins.detail.requiresRestart': '更改后需要重启',
  'host.settings.plugins.detail.requiresRestart.yes': '是',
  'host.settings.plugins.detail.requiresRestart.no': '否',
  'host.settings.plugins.restartBadge': '需重启',
  'host.settings.plugins.menu.enable': '启用',
  'host.settings.plugins.menu.disable': '禁用',
  'host.settings.plugins.menu.uninstall': '卸载',
  'host.settings.plugins.notImplemented': '尚未实现',
  'host.settings.plugins.builtinUndeletable': '内置插件不可卸载',
  'host.settings.plugins.disabledWarning': '该插件已禁用：它的视图不会出现在工作台里。',
  'host.settings.plugins.note':
    '启用状态会保存到用户配置目录，重启后仍然有效；卸载功能尚未实现，磁盘上的插件文件不会被删除。',
  'host.diff.title': 'Diff 对比',
  'host.diff.close': '关闭',

  // ---- 文件树（左上工具区，宿主内建视图）----
  'host.explorer.title': '文件',
  'host.explorer.empty': '这个项目里没有可显示的文件。',
  'host.explorer.error.invalid-path': '这个路径不可用。',
  'host.explorer.error.outside-project': '只能浏览当前项目里的文件。',
  'host.explorer.error.not-a-directory': '这不是一个文件夹。',
  'host.explorer.error.unreadable': '读不了这个文件夹：可能已被删除，或者没有访问权限。',
  'host.explorer.file.unsupported': '这个格式暂不支持打开（只有纯文本与 Markdown 可以）',
  'host.explorer.file.unreadable': '读不了这个文件：可能已被删除，或者没有访问权限。',
  'host.explorer.file.too-large': '这个文件太大，不适合在编辑器里打开。',
  'host.explorer.open.failed.invalid-path': '这个路径不可用。',
  'host.explorer.open.failed.outside-project': '只能打开当前项目里的文件。',
  'host.explorer.open.failed.not-a-file': '这不是一个文件。',
  'host.explorer.open.failed.unreadable': '读不了这个文件：可能已被删除，或者没有访问权限。',

  // 文件树右键菜单：一项「新建」，展开是两个名词。落点由被右键的条目决定
  // （目录 -> 内部，文件 -> 同级），所以菜单上不必写位置
  'host.explorer.menu.new': '新建',
  'host.explorer.menu.newFolder': '文件夹',
  'host.explorer.menu.newFile': '文件',

  // 新建对话框
  'host.explorer.newFile.inside': '在此文件夹中新建文件',
  'host.explorer.newFile.sibling': '在此处新建文件',
  'host.explorer.newFolder.inside': '在此文件夹中新建文件夹',
  'host.explorer.newFolder.sibling': '在此处新建文件夹',
  'host.explorer.name.placeholder': '名称',
  'host.explorer.name.confirm': '新建',
  'host.explorer.name.resolved': '将创建：{name}',
  'host.explorer.name.error.empty': '名称不能为空。',
  'host.explorer.name.error.path-separator': '名称里不能有「/」或「\\」。',
  'host.explorer.name.error.illegal-character': '名称里不能有 : * ? " < > | 或控制字符。',
  'host.explorer.name.error.leading-dot': '名称不能以点开头。',
  'host.explorer.name.error.trailing-space-or-dot': '名称不能以空格或点结尾。',
  'host.explorer.name.error.too-long': '名称过长。',
  'host.explorer.create.failed.invalid-name': '名称不合法。',
  'host.explorer.create.failed.already-exists': '这个名字已经有了。',
  'host.explorer.create.failed.not-a-directory': '这个位置不能新建条目。',
  'host.explorer.create.failed.unreadable': '新建失败：没有权限，或者磁盘不可写。',

  // ---- 中间的主编辑区（标签页）----
  'host.editor.empty.title': '没有打开的文件',
  'host.editor.empty.hint': '在左侧的文件树里点一个文件，它会在这里以标签页打开。',
  'host.editor.tab.close': '关闭',
  'host.editor.unsaved': '尚未保存：保存功能还没实现',
  'host.editor.unsaved.hint': '保存功能尚未实现，这里的改动不会写回磁盘。',

  'host.plugin.loading': '加载中…',

  'host.locale.switch.title': '切换语言',
  'host.locale.switch.message':
    '切换到「{label}」需要重启窗口才能完全生效，编辑器里未保存的内容会丢失。是否继续？',
  'host.locale.switch.confirm': '切换并重启',
  'host.locale.switch.cancel': '取消',
  'host.locale.switch.failed': '切换到「{locale}」失败，已保持当前语言。',

  'host.locale.fallback.notice': '没有找到「{locale}」对应的语言包，已回落到中文。',
  'host.locale.diagnostics.missing': '「{locale}」有 {count} 条文案未翻译，已回落成中文。',
  'host.locale.diagnostics.conflict':
    '「{locale}」的 {count} 条文案被多个语言包同时提供，已按第三方优先取用。'
} as const
