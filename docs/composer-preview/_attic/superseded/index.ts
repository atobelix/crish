/**
 * core/plugins — ProseMirror 插件的公开出口
 *
 * 行内实时预览的插件已迁移到 `core/live-preview/`，
 * 那里是自包含模块（schema + 解析 + 重解析 + 显隐 + 命令），
 * 不再从这里导出。
 */

export { createLivePreviewPlugin, livePreviewPluginKey, isNodeEditing } from './LivePreviewPlugin';
export type { LivePreviewState } from './LivePreviewPlugin';
