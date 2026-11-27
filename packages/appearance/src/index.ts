import type { NideContext } from '@nide/kernel/context.ts'
import { HostAppearance } from './appearance.ts'

/**
 * 主题 / 外观服务（`appearance.*`）。
 *
 * 偏好文件（`appearance.json`）与主题解析在这里；`nativeTheme` 那一下通过反向桥
 * （`kernel/src/shell.ts`）请 shell 做。shell 会缓存一份状态 —— 窗口底色与
 * `--nide-appearance=` 启动参数在建窗那一刻就固定了，等不了 RPC。
 */
export const appearanceService = {
  name: 'nide:service:appearance',
  inject: ['rpc', 'hostEnv'],

  apply(ctx: NideContext): void {
    const appearance = new HostAppearance({ userDataDir: ctx.hostEnv.userDataDir })

    ctx.provide('appearance', appearance)

    ctx.rpc.register('appearance', {
      init: () => appearance.init(),
      payload: () => appearance.payload(),
      setTheme: (request) => {
        const payload = (request ?? {}) as { theme?: unknown; followSystem?: unknown }
        return appearance.setTheme(String(payload.theme ?? ''), payload.followSystem === true)
      }
    })
  }
}

/** profile 直接列这个模块；loader 取 default 作为插件对象 */
export default appearanceService
