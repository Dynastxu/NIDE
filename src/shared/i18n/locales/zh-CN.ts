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
  'host.stripe.menu.language': '语言',

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
