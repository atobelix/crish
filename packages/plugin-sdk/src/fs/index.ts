// packages/plugin-sdk/src/fs/index.ts
// I8-E2 loader fs 注入面 barrel：PluginFs 接口 + Node 默认适配。
// 宿主（webview）实现 PluginFs 后注入 PluginDiscoverer / SkillLoader /
// PluginAPIDeps（依赖全注入原则，03 §3.2 理由 4）。

export type { PluginFs, PluginFsEntry, PluginFsStat } from './plugin-fs';
export { NodeFsAdapter } from './plugin-fs';
