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
