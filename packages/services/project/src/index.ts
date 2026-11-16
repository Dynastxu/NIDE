import type { NideContext } from '../../../kernel/src/context.ts'
import { HostProjectStore } from './host-project-store.ts'

/**
 * 项目生命周期服务（`project.*`）。
 *
 * 标准 Cordis 服务包：`apply` 里 `ctx.provide('project', store)` 把它挂到上下文，
 * 消费方用 `inject: ['project']` + `ctx.project`，不需要自建注册表。
 *
 * `resolveStartup()` 放在 `apply` 里：启动时决定「这次要不要直接进某个项目」，
 * 这个决定在建窗之前就要能拿到（shell 的 `project.startup`）。
 */
export const projectService = {
  name: 'nide:service:project',
  inject: ['rpc', 'hostEnv'],

  apply(ctx: NideContext): void {
    const store = new HostProjectStore(ctx.hostEnv.userDataDir)
    store.resolveStartup()

    ctx.provide('project', store)

    ctx.rpc.register('project', {
      list: () => store.list(),
      current: () => store.getCurrent(),
      startup: () => store.resolveStartup(),
      setCurrent: (dirPath) => store.setCurrent(String(dirPath ?? '')),

      open: (dirPath) => store.open(String(dirPath ?? '')),
      forget: (dirPath) => {
        store.forget(String(dirPath ?? ''))
        return store.list()
      },
      close: () => {
        store.close()
        return null
      }
    })
  }
}

/** profile 直接列这个模块；loader 取 default 作为插件对象 */
export default projectService
