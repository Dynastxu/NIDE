export * from './preference'

/**
 * 启动参数前缀：主进程把**完整偏好**喂进渲染进程。
 *
 * 为什么偏好要同步喂，而不是靠主进程广播（APPEARANCE_CHANNEL）：
 * `pushEventToRenderer` 只发给**此刻已经存在**的窗口。启动阶段窗口是一个一个建的，
 * 先建好的那个发不出广播，后建的也收不到 —— 设置页于是会显示一份"主题对了、但
 * 跟随系统没勾"的错状态，而这恰恰是用户唯一能看见这一页的地方。
 *
 * 同步喂进来就没有这个时序问题：任何窗口在首帧就拿到权威偏好。
 */
export const APPEARANCE_ARG_PREFIX = '--nide-appearance='

/**
 * 把偏好编码成启动参数的值。
 *
 * 用 `<theme>:<followSystem>` 这种极简格式而不是 JSON，理由和启动参数本身一样：
 * 它只经过 argv 一次、不参与任何持久化，越简单越不容易被引号或转义咬到。主题 id
 * 里的冒号会被自然丢掉（id 约定用点号分隔），解析失败则整条回落到默认偏好。
 */
export function encodeAppearancePreference(
  preference: import('./preference').AppearancePreference
): string {
  return `${preference.theme}:${preference.followSystem ? '1' : '0'}`
}

/**
 * 启动参数前缀：主进程把**当前配色是深是浅**喂进渲染进程。
 *
 * 为什么深浅也要同步喂，而不是等异步 IPC：渲染进程要在**首帧之前**决定根元素挂不挂
 * `.theme-light`，晚一步就会先按深色画一帧（选浅色时表现为整屏闪一下深色）。
 * 首帧之前能用的只有启动参数。
 */
export const THEME_PALETTE_ARG_PREFIX = '--nide-theme-palette='

/**
 * 主题偏好变化的**频道名**（主进程 -> 渲染进程）。
 *
 * 首帧那份偏好走启动参数（见 APPEARANCE_ARG_PREFIX），这条通道只负责**启动之后**
 * 的变化：用户在设置里提交了、系统外观变了（跟随系统时）、或别的窗口改了。
 *
 * 注意它**不是**一条独立的 Electron 事件名，而是 `host:event` 那条既有总线上的一
 * 个频道（见 main/ipc 的 pushEventToRenderer）：主进程 `send('host:event', 频道名, 载荷)`，
 * preload 收下来之后按这个字符串过滤。所以传的是**载荷**，不是偏好 —— 偏好里的
 * "跟随系统"目前恒为 false，界面读本地那份就够。
 *
 * 是否需要它由窗口模型决定：设置窗口和主窗口是两个渲染进程、两份 store，
 * 在设置里换主题，主窗口那边不会自己变 —— 必须有人推它一把。
 */
export const APPEARANCE_CHANNEL = 'host:appearance-changed'
