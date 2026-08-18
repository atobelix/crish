/**
 * Phase 2 Adapter：layout-tree 为 per-session Conversation Unit — re-export hub。
 *
 * 本文件原为 805 行单体，现按职责拆分为 2 个子模块（hub re-export 保证
 * 消费方 import 路径不变）：
 *  - adapterShapeTreeOps.ts：纯树操作（计数 / clamp / collapse / expand / project / normalize）
 *  - adapterShapeStoreOps.ts：Store 写入 API（applyDock* / ensure* / reproject）
 *
 * 拆分动机：T4-11（SR-06-R2）基线清零 — 805 行 → hub ~12 行（各子模块 ≤400）。
 *
 * 关键：applyDock / ensure* 只改目标 session 的 unit，不整树重建、不剥离其它 session 的 tool。
 * @see docs/plans/2026-07-conversation-unit-shell.md §2.3
 * @see analysis/shell_workspace_redesign.md §4.5.3
 */

export * from './adapterShapeTreeOps';
export * from './adapterShapeStoreOps';
