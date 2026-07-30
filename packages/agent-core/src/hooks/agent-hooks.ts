/**
 * @deprecated 请使用 ToolHook（精简 3 方法）替代 AgentHooks。
 *
 * ## 迁移指南
 *
 * AgentHooks 已废弃，由统一的 ToolHook 链替代。
 *
 * ### 替代方案
 *
 * | AgentHooks 方法       | ToolHook 替代              |
 * |-----------------------|----------------------------|
 * | beforeToolCall(ctx)   | beforeExecute(input, ctx)  |
 * | afterToolCall(ctx)    | onResult(result, ctx)      |
 * | shouldStopAfterTurn   | 移至 AgentSessionLoop 配置  |
 * | prepareNextTurn       | 移至 AgentSessionLoop 配置  |
 * | onError(error, ctx)   | onError(error, ctx)         |
 *
 * ### 迁移步骤
 *
 * 1. 将 `beforeToolCall` 逻辑迁移到 `beforeExecute`，输入改为 `(input, ctx)`
 * 2. 将 `afterToolCall` 逻辑迁移到 `onResult`，输出改为 `(result, ctx)`
 * 3. 将 `shouldStopAfterTurn` / `prepareNextTurn` 提取为独立的 AgentSessionLoop 配置
 * 4. 通过 ToolHook[] 数组直接注册多个 Hook
 *
 * ### 示例
 *
 * ```typescript
 * // 新方式
 * const hook: ToolHook = {
 *   beforeExecute: (input, ctx) => ({ status: "approved", modifiedInput: input }),
 *   onResult: (result, ctx) => result,
 * };
 * ```
 *
 * @see ToolHook — 新的 Tool 生命周期 Hook 接口（3 方法）
 * @removeWhen 所有消费者迁移至 ToolHook
 */

export type { AgentHooks } from "./hook-types";
