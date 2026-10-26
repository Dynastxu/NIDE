import type { Context } from '@deepseek-ai/cordis'

/** 插件身份，loader 用它做诊断与去重。 */
export const name = 'nide-hello'

/** 这个插件不依赖任何宿主服务。 */
export const inject: string[] = []

export interface Config {
  greeting?: string
}

/**
 * 最小可验证插件：证明 loader 能导入 TS、Cordis 能激活/释放 effect。
 *
 * TODO: 换成真正的 NIDE 服务（fs / project / shell 等），并删除定时器。
 */
export function apply(ctx: Context, config: Config = {}): void {
  const logger = ctx.logger('nide-hello')
  logger.info(config.greeting ?? 'hello from @nide/hello')

  ctx.effect(() => {
    const timer = setInterval(() => logger.debug('tick'), 60_000)
    return () => clearInterval(timer)
  }, 'nide-hello: keep-alive')
}
