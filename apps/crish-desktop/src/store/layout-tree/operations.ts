/**
 * 二叉树布局操作 — re-export hub。
 *
 * - layoutTreeQuery.ts      — 查询
 * - layoutTreeInsert.ts     — insertTab / addTab / splitTab / splitLeaf / mergeBranch
 * - layoutTreeMoveRemove.ts — removeTab / moveTab / pruneEmptyLeaves / 几何挪叶
 * - layoutTreeTransform.ts  — activateTabInTree / updateTabDock / applyDrop / resize
 * - layoutTreeFlatten.ts    — flattenTree
 */
export * from './layoutTreeQuery';
export * from './layoutTreeInsert';
export * from './layoutTreeMoveRemove';
export * from './layoutTreeTransform';
export * from './layoutTreeFlatten';
