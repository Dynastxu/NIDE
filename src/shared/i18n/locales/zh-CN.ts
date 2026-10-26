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

  // ---- 视图外壳（标题栏）----
  // 所有 ViewLocation 上的视图共用这一套外壳：宿主画标题栏与标签条，视图往里面
  // 写内容。这几条是外壳自己画出来的按钮与标签条的说法
  'host.view.more': '更多',
  'host.view.collapse': '收起视图',
  'host.view.tabs': '标签页',
  'host.view.tab.close': '关闭',
  'host.view.tab.status': '关闭（这个标签有未保存的改动）',
  'host.editor.title': '编辑器',

  // ---- 窗口（自定义标题栏）----
  'host.window.minimize': '最小化',
  'host.window.maximize': '最大化',
  'host.window.restore': '向下还原',
  'host.window.close': '关闭',

  // ---- 主窗口标题栏的菜单（文件 / 编辑）----
  'host.menu.button': '菜单',
  'host.menu.file': '文件',
  // 保存：与 Ctrl+S、标签条「更多」里的那一项是同一个动作（见 renderer/editor 的 saveActiveTab）
  'host.menu.file.save': '保存',
  'host.menu.file.save.disabled': '当前标签页没有未保存的改动。',
  'host.menu.file.closeProject': '关闭项目',
  'host.menu.file.closeProject.confirm.title': '关闭项目',
  'host.menu.file.closeProject.confirm.message':
    '关闭当前项目并回到欢迎窗口？项目会留在「打开过的项目」列表里，下次启动仍然默认打开它。',
  'host.menu.file.quit': '退出',
  'host.menu.file.quit.confirm.title': '退出应用',
  'host.menu.file.quit.confirm.message': '退出会关闭所有窗口。是否继续？',
  // 提交是宿主级的入口：目前只把右下那一栏切到提交视图，不做任何提交动作
  'host.menu.file.commit': '提交',
  'host.menu.edit': '编辑',
  'host.menu.edit.undo': '撤销',
  'host.menu.edit.redo': '重做',
  'host.menu.edit.notImplemented': '尚未实现',

  // ---- 通用确认框 ----
  'host.dialog.cancel': '取消',

  /**
   * ---- 行为级二次确认 ----
   *
   * 这几条由**主进程**用（见 main/confirm.ts 的 CONFIRM_SPECS）：关闭项目、退出、
   * 删除、换项目、重启、关窗那几问的文案都在那里挑。放同一张表里是因为
   * 「谁翻」不影响「词条归宿主」—— 渲染进程那一侧只有一个不认识业务的浮层。
   */
  'host.window.close.confirm.title': '关闭窗口',
  'host.window.close.confirm.message':
    '关闭这个窗口？未保存的编辑内容会丢失。在 Windows / Linux 上，最后一个窗口关闭后应用会退出。',
  'host.window.close.confirm.action': '关闭窗口',
  'host.project.switch.confirm.title': '切换项目',
  'host.project.switch.confirm.message':
    '打开「{name}」会重建当前窗口，未保存的编辑内容会丢失。是否继续？',
  'host.project.switch.confirm.action': '打开',
  'host.restart.confirm.title': '重启应用',
  'host.restart.confirm.message': '重启会重建窗口，未保存的编辑内容会丢失。是否继续？',
  'host.restart.confirm.action': '重启',

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
  'host.welcome.projects.error.unreadable': '宿主进程没有响应，读不到这个项目：{path}',

  // ---- 设置 ----
  'host.settings.button': '设置',
  'host.settings.menu.global': '全局设置',
  'host.settings.menu.project': '项目设置',
  'host.settings.title': '设置',
  'host.settings.nav.title': '设置选项',
  'host.settings.page.general': '通用',
  'host.settings.page.language': '语言',
  'host.settings.page.appearanceBehavior': '外观与行为',
  'host.settings.page.appearance': '外观',
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

  // 设置 -> 外观与行为 -> 外观
  'host.settings.appearance.description':
    '选择界面的配色。宿主内置深色与浅色两套。改完点「应用」或「确定」生效，不需要重启。',
  'host.settings.appearance.theme': '主题',
  'host.settings.appearance.followSystem.label': '与操作系统同步',
  'host.settings.appearance.followSystem.hint': '跟随系统的深色 / 浅色外观自动切换',
  'host.settings.appearance.followSystem.unavailable': '跟随系统暂未实现，这一项还不能选。',

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
  'host.settings.plugins.install': '从文件夹安装',
  'host.settings.plugins.install.failed':
    '安装失败：目录里没有可用的 manifest.json，或者同名插件已经存在。',
  'host.settings.plugins.disabledWarning': '该插件已禁用：它的视图不会出现在工作台里。',
  'host.settings.plugins.note':
    '启用状态会保存到用户配置目录，重启后仍然有效；卸载会删除用户安装的插件目录，内置插件不可卸载。',

  // 插件安装 / 卸载（主进程的动作出口）
  'host.plugins.install.title': '选择插件文件夹',
  'host.plugins.trust.title': '启用第三方插件',
  'host.plugins.trust.message':
    '插件「{name}」拥有完整的 Node 权限，可以读写你的文件和网络。只启用你信任的插件。',
  'host.plugins.trust.confirm': '启用',
  'host.plugins.uninstall.title': '卸载插件',
  'host.plugins.uninstall.message': '卸载「{name}」会删除它的插件目录，之后可以重新安装。',
  'host.plugins.uninstall.confirm': '卸载',
  'host.diff.title': 'Diff 对比',
  'host.diff.close': '关闭',

  // ---- 宿主内建视图的占位页（版本控制 / 提交）----
  // 两者都还没有接版本控制实现，这里只有按钮名与那行占位文案
  'host.git.title': '版本控制',
  'host.git.placeholder': '版本控制面板尚未实现。',
  'host.commit.title': '提交',
  'host.commit.placeholder': '提交页面尚未实现。',

  // ---- 文件树（左上工具区，宿主内建视图）----
  'host.explorer.title': '文件',
  // 这个视图的两个标签页：文件树，以及按四个内容目录分组的项目内容
  'host.explorer.tab.files': '文件',
  'host.explorer.tab.projects': '项目',
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

  // 条目右键菜单：一项「新建」，展开是两个名词。落点由被右键的条目决定
  // （目录 -> 内部，文件 -> 同级），所以菜单上不必写位置。
  // 这一块由条目动作层装配，文件树与章节列表共用（见 renderer/src/entry/entry-menu.ts）
  'host.explorer.menu.new': '新建',
  'host.explorer.menu.newFolder': '文件夹',
  'host.explorer.menu.newFile': '文件',
  'host.explorer.menu.rename': '重命名',
  'host.explorer.menu.delete': '删除',
  // 章节列表自己加的那一项。它与上面「新建 -> 文件」是两个动作：那个建出来的是空文件
  // （先占个位置），这个建出来开头就带着章节属性（见 explorer/chapter-actions.ts）
  'host.explorer.menu.newChapter': '新建章节',
  // 伏笔列表自己加的那一项，与「新建章节」同一条边界：建出来开头就带着伏笔属性
  'host.explorer.menu.newForeshadowing': '新建伏笔',

  // 新建对话框
  'host.explorer.newFile.inside': '在此文件夹中新建文件',
  'host.explorer.newFile.sibling': '在此处新建文件',
  'host.explorer.newFolder.inside': '在此文件夹中新建文件夹',
  'host.explorer.newFolder.sibling': '在此处新建文件夹',
  'host.explorer.name.placeholder': '名称',
  'host.explorer.name.confirm': '新建',
  // 名字没有扩展名时被补上了那一个（图鉴条目）：把落盘的名字说出来，
  // 免得磁盘上的名字与输入框里那个不一样
  'host.explorer.name.savedAs': '会存成「{name}」',
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

  // 重命名对话框。与新建共用输入框，只有标题、按钮和失败文案不同
  'host.explorer.rename.title': '重命名',
  'host.explorer.rename.confirm': '重命名',
  'host.explorer.rename.extensionChanged':
    '扩展名变了：它会存成「{name}」，宿主按新扩展名决定能不能打开它。',
  'host.explorer.rename.failed.invalid-name': '名称不合法。',
  'host.explorer.rename.failed.already-exists': '这个名字已经有了（重命名不会覆盖它）。',
  'host.explorer.rename.failed.not-a-file': '这个条目已经不在了，或者不是一个文件或文件夹。',
  'host.explorer.rename.failed.unreadable': '改名失败：没有权限，或者磁盘不可写。',

  // 删除的确认与失败。删除是唯一不可撤销的动作，所以它走确认框而不是输入框
  'host.explorer.delete.title.file': '删除文件',
  'host.explorer.delete.title.folder': '删除文件夹',
  'host.explorer.delete.message.file': '确定删除「{name}」吗？删掉之后就找不回来了。',
  'host.explorer.delete.message.folder':
    '确定删除「{name}」吗？文件夹里的东西会一起删掉，删完之后找不回来。',
  'host.explorer.delete.confirm': '删除',
  'host.explorer.delete.failed.not-empty': '这个文件夹不是空的，没有删除。',
  'host.explorer.delete.failed.not-a-file': '这个条目已经不在了，或者不是一个文件或文件夹。',
  'host.explorer.delete.failed.is-project-root': '不能删除项目根目录。',
  'host.explorer.delete.failed.unreadable': '删除失败：没有权限，或者磁盘不可写。',

  // ---- 「项目」标签页：四个内容分类 ----
  // 分类名与 .nide/config.yml 里的四项一一对应（章节 / 图鉴 / 伏笔 / 概述）。
  // 目录名不在这里 —— 那由配置决定，界面只认这四个分类的显示名
  'host.project.panel.section.chapters': '章节',
  'host.project.panel.section.gallery': '图鉴',
  'host.project.panel.section.foreshadowing': '伏笔',
  'host.project.panel.section.overview': '概述',
  'host.project.panel.new': '新建',
  'host.project.panel.section.notImplemented': '尚未实现',
  'host.project.panel.chapter.empty': '这个目录里还没有章节。',
  // 编号读不出来时列表左边显示的字样：那是一个还没写章节属性的文件，不是错误
  'host.project.panel.chapter.unnumbered': '—',
  'host.project.panel.chapter.no-dir': '读不到章节目录：项目配置不可用。',
  'host.project.panel.chapter.failed.invalid-name': '名称不合法。',
  'host.project.panel.chapter.failed.already-exists':
    '这个名字已经有了（新建不会覆盖它）。改个名字，或者先重命名已有的那一章。',
  'host.project.panel.chapter.failed.not-a-directory': '章节目录不存在，或者那里不是一个文件夹。',
  'host.project.panel.chapter.failed.unreadable': '新建失败：没有权限，或者磁盘不可写。',

  // ---- 伏笔 ----
  // 内容目录里平铺的 yml（整份文件就是属性），字段固定为名称、起始章节、结束章节、
  // 描述（见 shared/project/foreshadowing）
  'host.project.panel.foreshadowing.new': '新建伏笔',
  'host.project.panel.foreshadowing.empty': '这个目录里还没有伏笔。',
  'host.project.panel.foreshadowing.no-dir': '读不到伏笔目录：项目配置不可用。',
  'host.project.panel.foreshadowing.failed.invalid-name': '名称不合法。',
  'host.project.panel.foreshadowing.failed.already-exists':
    '这个名字已经有了（新建不会覆盖它）。改个名字，或者先重命名已有的那一条。',
  'host.project.panel.foreshadowing.failed.not-a-directory':
    '伏笔目录不存在，或者那里不是一个文件夹。',
  'host.project.panel.foreshadowing.failed.unreadable': '新建失败：没有权限，或者磁盘不可写。',

  // ---- 图鉴 ----
  // 与章节的差别是**分区**：一个图鉴是内容目录下的一个子目录（角色 / 地点 / 物品……），
  // 子目录里的 config.yml 记着这个图鉴有哪些字段（见 shared/project/gallery）
  'host.project.panel.gallery.new': '新建图鉴',
  'host.project.panel.gallery.newEntry': '新建条目',
  'host.project.panel.gallery.editFields': '编辑字段',
  'host.project.panel.gallery.setCharacters': '设为角色图鉴',
  'host.project.panel.gallery.alreadyCharacters': '这个图鉴已经是角色图鉴了。',
  // 图鉴分组标题上的小标记：它是章节表单「出场角色」的来源
  'host.project.panel.gallery.characters': '角色图鉴',
  'host.project.panel.gallery.empty': '这个项目里还没有图鉴。',
  'host.project.panel.gallery.entry.empty': '这个图鉴里还没有条目。',
  'host.project.panel.gallery.no-dir': '读不到图鉴目录：项目配置不可用。',
  'host.project.panel.gallery.failed.invalid-name': '这个名字不能当图鉴名。',
  'host.project.panel.gallery.failed.unknown-gallery': '这个图鉴已经不在了。',
  // config.yml 是那个图鉴的字段表：拿它当条目名会建出一个列表里看不见的文件
  'host.project.panel.gallery.failed.reserved-name': '「config.yml」是图鉴字段表的名字，换一个。',
  'host.project.panel.gallery.failed.unreadable': '操作失败：没有权限，或者磁盘不可写。',

  // ---- 概述 ----
  // 概述目录里全是普通 Markdown；大纲 / 写作风格只是 .nide/config.yml 里的两个标记
  // （见 shared/project/overview）。没有标记的文件与该配置无关
  'host.project.panel.overview.newDocument': '新建文档',
  'host.project.panel.overview.empty': '这个目录里还没有概述文档。',
  'host.project.panel.overview.outline': '大纲',
  'host.project.panel.overview.style': '写作风格',
  'host.project.panel.overview.no-dir': '读不到概述目录：项目配置不可用。',
  'host.project.panel.overview.setOutline': '设为大纲',
  'host.project.panel.overview.setStyle': '设为写作风格',
  'host.project.panel.overview.alreadyOutline': '这个文件已经是大纲了。',
  'host.project.panel.overview.alreadyStyle': '这个文件已经是写作风格了。',
  'host.project.panel.overview.outline.isStyle': '这个文件已经是写作风格了，不能同时当大纲。',
  'host.project.panel.overview.style.isOutline': '这个文件已经是大纲了，不能同时当写作风格。',
  'host.project.panel.overview.failed.invalid-name': '名称不合法。',
  'host.project.panel.overview.failed.already-exists':
    '这个名字已经有了（新建不会覆盖它）。改个名字，或者先处理已有的那一个。',
  'host.project.panel.overview.failed.not-a-directory': '概述目录不存在，或者那里不是一个文件夹。',
  // 概述面板只列 Markdown：建一份 .txt 出来它不会出现在这个面板里，等于没建成
  'host.project.panel.overview.failed.not-markdown': '概述里只列 Markdown 文档，请用 .md。',
  'host.project.panel.overview.failed.unreadable': '操作失败：没有权限，或者磁盘不可写。',
  'host.project.panel.overview.role.failed.invalid-name': '这个名字不能当这个角色。',
  'host.project.panel.overview.role.failed.unknown-file': '这份文档已经不在了。',
  'host.project.panel.overview.role.failed.unreadable': '操作失败：没有权限，或者磁盘不可写。',

  // 图鉴条目的表单：字段名与值都由这个图鉴的 config.yml 决定，所以界面不写死任何字段
  'host.editor.gallery.empty': '这个图鉴还没有字段。先在图鉴的 config.yml 里加上几个。',
  'host.editor.gallery.extra':
    '下面这些字段不在图鉴配置里（可能是字段改过名）。它们会原样保留，不会被删掉。',
  'host.editor.gallery.value.placeholder': '留空表示这一项还没写',

  // 图鉴字段表的表单（编辑 config.yml）
  'host.editor.gallery.config.title': '图鉴字段',
  'host.editor.gallery.config.hint':
    '一个字段一行，顺序就是条目表单里的顺序。第一个字段用来当条目的名字。',
  'host.editor.gallery.config.first': '条目的名字',
  'host.editor.gallery.config.placeholder': '字段名',
  'host.editor.gallery.config.add': '添加字段',
  'host.editor.gallery.config.add.disabled': '字段数量已经到上限。',
  'host.editor.gallery.config.remove': '删除这个字段',
  'host.editor.gallery.config.invalid.empty': '字段名不能为空。',
  'host.editor.gallery.config.invalid.illegal-character':
    '字段名里不能有空格、冒号、# 或控制字符。',
  'host.editor.gallery.config.invalid.too-long': '字段名过长。',
  'host.editor.gallery.config.invalid.duplicate': '这个字段已经有了。',

  // ---- 中间的主编辑区（标签页）----
  'host.editor.empty.title': '没有打开的文件',
  'host.editor.empty.hint': '在左侧的文件树里点一个文件，它会在这里以标签页打开。',
  'host.editor.tab.close': '关闭',
  // 保存：Ctrl+S / 文件菜单 / 标签条右上角的「更多」共用同一句话
  'host.editor.save': '保存',
  // 关掉一个改过的标签页时问的那一句。三个按钮：保存 / 不保存 / 取消
  'host.editor.unsaved.title': '「{name}」有未保存的改动',
  'host.editor.unsaved.message': '要保存这些改动吗？不保存的话，关掉这个标签页就会丢掉它们。',
  // 「不保存」而不是「丢弃」：界面上要否定的正是「保存」这个动作
  'host.editor.unsaved.discard': '不保存',
  // 保存失败：按原因分开说，它们要做的事不一样（改名 / 找权限 / 腾空间）
  'host.editor.save.failed.invalid-path': '这个文件的路径不可用，没有保存。',
  'host.editor.save.failed.outside-project': '这个文件不在当前项目里，没有保存。',
  'host.editor.save.failed.not-text': '这个格式宿主不解码，没有保存。',
  'host.editor.save.failed.not-a-file':
    '这个文件已经不在了，或者它不是一个文件（可能被删掉、改名，或被换成了链接）。',
  'host.editor.save.failed.too-large': '保存失败：内容太大，或者磁盘空间不够。',
  'host.editor.save.failed.unreadable': '保存失败：没有权限，或者磁盘不可写。',
  // 标题栏右上角「更多」菜单：一次关掉多个标签页。有未保存改动的那些会逐个问一句
  'host.editor.menu.closeOthers': '关闭其他标签页',
  'host.editor.menu.closeOthers.disabled': '只开着一个文件。',
  'host.editor.menu.closeSaved': '关闭未改动的标签页',
  'host.editor.menu.closeSaved.disabled': '每个打开的文件都有未保存的改动。',
  'host.editor.menu.closeAll': '关闭全部标签页',

  // ---- 当前文件怎么看（标题栏上、Markdown 文件才有的一组按钮）----
  // 四种模式互斥，所以它们是一组开关而不是标签条（见 editor/DocumentViewModes）
  'host.editor.view.label': '视图模式',
  'host.editor.view.text': '纯文本',
  'host.editor.view.form': '表单',
  'host.editor.view.split': '拆分文本及预览',
  'host.editor.view.preview': '预览',
  // 正文为空时预览里的一句话：一片留白看起来像坏了
  'host.editor.preview.empty': '这一篇还没有正文。',

  // ---- 章节表单（frontmatter 里的那几项元数据）----
  // 只对写了 `category: chapter` 的文件出现（见 editor/document-mode.ts）
  'host.editor.form.index': '索引',
  'host.editor.form.index.hint': '0 是序章',
  'host.editor.form.index.placeholder': '留空表示还没编号',
  'host.editor.form.outline': '细纲',
  'host.editor.form.outline.placeholder': '这一章要写什么',
  'host.editor.form.characters': '出场角色',
  // 建议来自角色图鉴（.nide/config.yml 的 gallery.characters 记着是哪一个），
  // 但仍然可以手写一个还没建档的角色
  'host.editor.form.characters.hint': '从角色图鉴里选，也可以直接输入一个还没建档的名字',
  'host.editor.form.characters.placeholder': '输入名字后回车',
  'host.editor.form.characters.remove': '把「{name}」从出场角色里去掉',
  'host.editor.form.characters.missing':
    '还没有角色图鉴：在「项目 -> 图鉴」里新建一个，或者把已有的那个设为角色图鉴。',
  'host.editor.form.body': '正文',
  'host.editor.form.notes': '备注',
  'host.editor.form.notes.placeholder': '备注',
  'host.editor.form.summary': '概述',
  'host.editor.form.summary.placeholder': '这一章的概述',

  // ---- 伏笔表单（整份 yml 里的四个固定字段）----
  // 只对写了 `category: foreshadowing` 的 yml 出现（见 editor/document-mode.ts）
  'host.editor.form.foreshadowing.name': '名称',
  'host.editor.form.foreshadowing.name.placeholder': '这条伏笔叫什么',
  'host.editor.form.foreshadowing.start': '起始章节',
  'host.editor.form.foreshadowing.end': '结束章节',
  // 起止是对章节的引用，不是章节自己的编号：章节号与章节标题都能写
  'host.editor.form.foreshadowing.chapter.hint': '可以写章节号，也可以写章节标题',
  'host.editor.form.foreshadowing.chapter.placeholder': '留空表示还没想好',
  'host.editor.form.foreshadowing.description': '描述',
  'host.editor.form.foreshadowing.description.placeholder': '埋下了什么，准备在哪儿收束',

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
