/**
 * 二叉树布局操作 — re-export hub。
 *
 * 原 764 行单文件拆分为 5 个职责域子模块：
 * - layoutTreeQuery.ts      — 查询（findNodeById / findParent / collectLeaves）
 * - layoutTreeInsert.ts     — 插入/拆分/合并（splitLeaf / mergeBranch / insertLeafBesideNode / addTabToLeaf）
 * - layoutTreeMoveRemove.ts — 移动/删除（moveLeaf / moveNode / removeNodeFromTree / removeLeafFromTree / removeTabFromLeaf）
 * - layoutTreeTransform.ts  — resize/leaf 绑定/拖拽提交/迁移（resizeBranch / setLeafActiveTab / setLeafSessionId / applyDrop / migrateFromColumns）
 * - layoutTreeFlatten.ts    — 树展平渲染列表（flattenTree）
 *
 * 本文件仅做 re-export，保持消费方 import 路径不变。
 * 子模块只 import ./types / ./dropDetection / ./index，不 import 本 hub（无循环依赖）。
 */
export * from './layoutTreeQuery';
export * from './layoutTreeInsert';
export * from './layoutTreeMoveRemove';
export * from './layoutTreeTransform';
export * from './layoutTreeFlatten';
