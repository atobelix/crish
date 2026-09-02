/**
 * Adapter hub：不再把坞投影成 H(chat, tool)。
 *
 * 保留计数 / clamp / ensureAdapterShape（至少 1 chat 叶）。
 * 开工具走 openTool.ts → updateTabDock。
 */

export * from './adapterShapeTreeOps';
export * from './adapterShapeStoreOps';
