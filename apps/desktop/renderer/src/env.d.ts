// Vite 的客户端类型：`import.meta.env`、`import ... from 'x?url'` 这类资源导入的
// 模块声明都在里面（见 node_modules/vite/client.d.ts 的 `declare module '*?url'`）。
// 自定义标题栏的应用图标就是靠它 import 的，别删这一行。
/// <reference types="vite/client" />
