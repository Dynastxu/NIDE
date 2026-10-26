import type { NideContext } from '../../../kernel/src/context.ts'
import { HostProjectStore } from './host-project-store.ts'

/**
 * 项目生命周期服务（`project.*`）。
 *
 * 第一个真正的「服务包」：它不 import 宿主入口，也不 import 其它服务 —— 只拿
 * `ctx.rpc` / `ctx.services` / `ctx.env`。别的东西要用它，通过
 * `ctx.services.require<HostProjectStore>('project')`。
 *
 * `resolveStartup()` 放在 `apply` 里：启动时决定「这次要不要直接进某个项目」，
 * 这个决定在建窗之前就要能拿到（shell 的 `project.startup`）。
 */
export const projectService = {
  name: 'nide:service:project',

  apply(ctx: NideContext): void {
    const store = new HostProjectStore(ctx.env.userDataDir)
    store.resolveStartup()

    ctx.services.provide('project', store)

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

/** profile 通过 `kind: service` 行指向本文件，宿主入口取 default 后 apply */
export default projectService
