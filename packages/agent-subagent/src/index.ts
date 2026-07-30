/**
 * @crish/agent-subagent — 子代理调度骨架（Layer 5）
 *
 * 导出子代理调度器接口骨架、递归守卫增强接口、子代理执行循环、上下文打包等。
 *
 * 拓扑层（01-OVERVIEW.md §3.2）：Layer 5。
 * 依赖约束：依赖 agent-core / agent-tools / agent-mcp / agent-context /
 * shared-types / shared-utils，不依赖 agent-orchestrator / agent-daemon。
 *
 * 依据 禁令 20：SubagentScheduler / SubagentInstance / DeadlockDetector 仅定义接口签名，
 * Round 9 完整实现。SubagentWatchdog.stuckDetection / TokenBudgetTracker /
 * priority/affinity / isolationMode / SubagentState.paused 均推迟。
 *
 * 依据 禁令 20：禁止新建 SubagentCommunicationBus，子代理通信复用 ControlBus。
 */

export * from "./subagents";
export * from "./subagent-loop";
export * from "./subagent-skill-runner";
export * from "./subagent-types";
export * from "./subagent-context-pack";
export * from "./scheduler";
export * from "./recursion-guard";
