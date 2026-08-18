/**
 * 目标模式（/goal）控制器 — re-export hub。
 *
 * 本文件原为 813 行单体，现按职责拆分为 3 个子模块（hub re-export 保证
 * 消费方 import 路径不变）：
 *  - goalModeContinuation.ts：续写决策 / 提示构造 / checklist 解析纯函数
 *  - goalModeLifecycleTypes.ts：lifecycle 类型 / 工厂 / 桥接函数
 *  - goalModeLifecycleTransitions.ts：lifecycle 状态转移逻辑
 *
 * 拆分动机：T4-11（SR-06-R2）基线清零 — 813 行 → hub ~20 行（各子模块 ≤400）。
 */

export * from './goalModeContinuation';
export * from './goalModeLifecycleTypes';
export * from './goalModeLifecycleTransitions';
