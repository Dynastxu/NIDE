import { createContext, use } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'
import { createAppearanceStore, type AppearanceState } from './appearance.store'
import { createI18nStore, type I18nState } from './i18n.store'
import { createLayoutStore, type LayoutState } from './layout.store'
import { createPluginStore, type PluginState } from './plugin.store'

/**
 * 客户端 store 的**工厂与注入点**。
 *
 * 之前四张表都是模块级 `create()` 单例：import 即创建，谁都拿同一个实例，测试与
 * 「同一 realm 里跑第二棵树」都没有第二条路。DSH 的规则是「模块级 handle 禁止，
 * store 由装配点创建并按作用域注入」——这里落成两半：
 *
 * 1. `createClientStores()`：**工厂**，每次调用得到一套独立实例；
 * 2. `ClientStoresProvider` + `useClientStores()`：**注入**，React 树从 context 取；
 *    没有 Provider 时回落到 `getClientStores()` 的默认实例（测试、独立渲染、
 *    插件视图单挂都能用），默认实例也是懒创建的，不在 import 时产生副作用。
 *
 * 非 React 代码（启动编排、菜单装配、日志回调）用 `getClientStores()` 取同一份
 * 默认实例；装配点把它显式传给 Provider，保证 React 里外看到的是同一套。
 *
 * 这个文件与四个 store 模块互相 import（工厂 ↔ 取实例的 hook）。**循环是安全的**：
 * 两个方向都只在函数体内取对方，模块求值阶段没有顶层副作用。
 */
export interface ClientStores {
  i18n: StoreApi<I18nState>
  appearance: StoreApi<AppearanceState>
  layout: StoreApi<LayoutState>
  plugin: StoreApi<PluginState>
}

export const ClientStoresContext = createContext<ClientStores | null>(null)

/** 造一套独立实例（测试、多树、将来一个窗口多工作区都用它） */
export function createClientStores(): ClientStores {
  return {
    i18n: createI18nStore(),
    appearance: createAppearanceStore(),
    layout: createLayoutStore(),
    plugin: createPluginStore()
  }
}

/** 渲染进程的默认实例：懒创建，装配点（引导壳）显式交给 Provider */
let defaultStores: ClientStores | null = null

export function getClientStores(): ClientStores {
  defaultStores ??= createClientStores()
  return defaultStores
}

/** React 树里取一套：Provider 给什么用什么，没有就回落到默认实例 */
export function useClientStores(): ClientStores {
  return use(ClientStoresContext) ?? getClientStores()
}

/**
 * 订阅一张表的某个切片。
 *
 * 只是 `useStore(api, selector)` 的薄封装，存在的意义是让上面那句「从 context 拿
 * 实例」只写一处。
 */
export function useClientStore<T, S>(api: StoreApi<T>, selector: (state: T) => S): S {
  return useStore(api, selector)
}
