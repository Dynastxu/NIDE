import DemoView from './index'

/**
 * demo 插件浏览器半的入口。
 *
 * 构建产物是一个 IIFE：加载时通过宿主注入的 `window.__NIDE_REGISTER__`
 * 把视图组件注册进 `ClientModuleRegistry`。React 由宿主以全局变量提供，
 * 这个 bundle 里不打包 React。
 */
type Register = (id: string, component: unknown) => void

const register = (window as unknown as { __NIDE_REGISTER__?: Register }).__NIDE_REGISTER__

if (!register) {
  throw new Error(
    '__NIDE_REGISTER__ is not available; the host must inject it before loading plugin bundles'
  )
}

register('demo.hello', DemoView)
