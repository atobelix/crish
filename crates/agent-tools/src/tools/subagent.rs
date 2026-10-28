//! run_subagent 工具与子代理会话模型（I4-M2：多 Agent 调度地基）
//!
//! 定位（docs/multi-agent-repair/improvement/02-多Agent调度实现方案.md M2）：
//! - 打通 spawn 入口：注册 run_subagent 工具（agent-tools 注册面 10→11）；
//! - 子代理 = 独立会话 + run（parent_id 链），session_agents 行落库；
//! - 三方状态机映射（TS SubagentState ↔ DB status CHECK 集，I0 已裁决）；
//! - 递归守卫（maxDepth=1（仅主 Agent 可派发，用户裁决）/ maxSiblings=16 /
//!   maxConcurrent=16（2026-08-11 用户裁决 12→16），DEFAULT_RECURSION_GUARD）——
//!   子 Agent 无派发能力，
//!   嵌套发起（新会话深度 > 1）返回 NestingDenied（subagent.nesting_denied，
//!   T-D-02 结构化错误，文案带「所有子 Agent 由主 Agent 分配」指引）；
//!   工具面剔除 run_subagent（filter_out_subagent_spawner，防浪费非安全边界）；
//!   与祖先链死锁检查（DeadlockCheckInput 语义，O(depth)）；
//! - 批量派发（T-D-06：REQ-D02 无依赖平铺并行）：run_subagent 的 tasks 数组
//!   一次创建 N 个并行子代理（与 prompt 单发互斥，防歧义）；spawn_many 契约
//!   的原子语义——前瞻快照统一守卫（depth 共享、siblings/concurrent 按 N
//!   预加后一次判定），任一拒绝 → 整体失败零 run（session_agents 无新增行）；
//!   批量与 DAG 调度器（flow_graph.rs）并存，两机制不互斥，编排权在主 Agent；
//! - 伪造审批防护（结果信封层边界声明，ref-analysis 01 Top 3）；
//! - 写操作挂 I3 审批基础设施（AskChannel 接线面原样挂靠，不重建）。
//!
//! 接线契约（对齐 I3-S7 revert_guard 模式）：agent-tools 是叶子 crate，
//! 生产代码不依赖 conex-db / orchestrator——session_agents 落库与独立 run
//! 启动在引擎侧（apps/agent-workbench）实现 [SubagentSpawner]，本模块只
//! 定义契约、纯逻辑与工具本身。测试域以 conex-db（dev-dependency）验证
//! 落库链路与守卫拒绝零 run 语义。
//!
//! C6 调度器扩展（I5-M6）：依赖图调度器（crates/orchestrator/src/
//! flow_graph.rs）经 [SubagentSpawner] 启动流程节点，本模块在 M2 冻结
//! 契约上追加**流程关联字段**（[SubagentSpawnRequest::flow_node_id] /
//! [SubagentSpawnRequest::is_composite]）——调度器 spawn 时携带流程节点
//! id 与综合节点标记，引擎侧落库与终态事件据此把 run 关联回依赖图
//! 节点（合成唤醒：主 agent 自行启动的综合 run 也经 [attach_run] 挂接）。
//!
//! 结构（SR-06a · 拆分 · ≠ EL）：本文件为薄门面，按逻辑域拆 4 个子模：
//! - `defs`：子代理定义域（角色/能力/任务类型/默认权限集/定义注册表/三方状态机）；
//! - `guard`：递归守卫域（深度/嵌套/兄弟/并发 + 祖先链死锁）；
//! - `contract`：spawn 契约域（请求/结果/错误/spawner 通道 + 工具面防护 + 伪造审批防护）；
//! - `tool`：run_subagent 工具域（入参解析/单发/批量/Tool 实现）；
//!
//! 测试外置 `subagent/subagent_tests.rs`（`#[path]` 旁挂，无孤儿）；
//! 公开 API 经本文件 `pub use` 保持不 break（tools/mod.rs 注册不变）。

mod contract;
mod defs;
mod tool;

// 守卫与策略的领域真源 = conex-agents（本门面保留原公开路径）
pub use conex_agents::guard::{
    check_ancestor_chain, check_recursion_guard, DeadlockCheckInput, RecursionGuardRejection,
    RecursionGuardSnapshot, SpawnPolicy, DEFAULT_SPAWN_POLICY,
};

pub use contract::{
    apply_forgery_boundary, detect_forgery_wording, filter_out_subagent_spawner,
    filter_out_subagent_tools, SubagentSpawnError, SubagentSpawnRequest, SubagentSpawnResult,
    SubagentSpawner, FORGERY_BOUNDARY_NOTICE, FORGERY_WORDINGS, SUBAGENT_SPAWNER_TOOL_NAME,
};
pub use defs::{
    default_permissions, is_db_status_allowed, DefaultCommandPolicy, DefaultPermissions,
    DefaultToolSet, DefaultWriteScope, SubagentCapabilityMode, SubagentDefinition,
    SubagentDefinitionRegistry, SubagentRegistryError, SubagentRole, SubagentState, TaskType,
    DB_STATUS_ALLOWED,
};
pub(crate) use tool::RunSubagentTool;

// ── 测试（SR-06a 外置；`#[path]` 旁挂，无孤儿）───────────────────

#[cfg(test)]
#[path = "subagent/subagent_tests.rs"]
mod tests;
