//! 错误码常量集（`crate::error::codes`，TS 端 CrishErrorCode 同构）
//!
//! 来源：packages/shared-types/src/errors/codes.ts
//! 权威：03-ERROR-MIGRATION.md §2.2

// ── config 域（3 正式码）──
pub const CONFIG_INVALID: &str = "config.invalid";
pub const CONFIG_MISSING: &str = "config.missing";
pub const CONFIG_PARSE_FAILED: &str = "config.parse_failed";
// ── session 域（6 正式码 + 1 跨线共享码）──
pub const SESSION_NOT_FOUND: &str = "session.not_found";
pub const SESSION_INVALID_SESSION: &str = "session.invalid_session";
pub const SESSION_INVALID_ENTRY: &str = "session.invalid_entry";
pub const SESSION_INVALID_STATE: &str = "session.invalid_state";
pub const SESSION_STORAGE_FAILED: &str = "session.storage_failed";
pub const SESSION_REWIND_FAILED: &str = "session.rewind_failed";
/// 会话互斥（S3 ActivationGate 跨线共享码：browser_* 与 computer_* 共用，
/// 06 文档 §5 码表；登记归属 session 域，守卫检查点在审批之前）
pub const TOOL_SESSION_EXCLUSIVE: &str = "tool.session.exclusive";
// ── agent 域（3 reserved 码）──
pub const AGENT_MAX_TURNS_REACHED: &str = "agent.max_turns_reached";
pub const AGENT_NO_PROGRESS: &str = "agent.no_progress";
pub const AGENT_INTERVENTION_REQUIRED: &str = "agent.intervention_required";
// ── runtime 域（4 正式码）──
pub const RUNTIME_UNEXPECTED_STATE: &str = "runtime.unexpected_state";
pub const RUNTIME_TRANSITION_FAILED: &str = "runtime.transition_failed";
pub const RUNTIME_ABORTED: &str = "runtime.aborted";
pub const RUNTIME_TIMEOUT: &str = "runtime.timeout";
// ── provider 域（17 正式码）──
pub const PROVIDER_NETWORK: &str = "provider.network";
pub const PROVIDER_GATEWAY_CHALLENGE: &str = "provider.gateway_challenge";
pub const PROVIDER_RATE_LIMIT: &str = "provider.rate_limit";
pub const PROVIDER_AUTH: &str = "provider.auth";
pub const PROVIDER_QUOTA: &str = "provider.quota";
pub const PROVIDER_ENDPOINT_UNAVAILABLE: &str = "provider.endpoint_unavailable";
pub const PROVIDER_SCHEMA: &str = "provider.schema";
pub const PROVIDER_SERVER: &str = "provider.server";
pub const PROVIDER_TIMEOUT: &str = "provider.timeout";
pub const PROVIDER_CANCELLED: &str = "provider.cancelled";
pub const PROVIDER_STREAM_INTERRUPTED: &str = "provider.stream_interrupted";
pub const PROVIDER_UNKNOWN: &str = "provider.unknown";
pub const PROVIDER_CONNECTION_ERROR: &str = "provider.connection_error";
pub const PROVIDER_NO_TOKEN: &str = "provider.no_token";
pub const PROVIDER_REAUTH_REQUIRED: &str = "provider.reauth_required";
pub const PROVIDER_FATAL: &str = "provider.fatal";
pub const PROVIDER_REFRESH_FAILED: &str = "provider.refresh_failed";
// ── context 域（2 正式码 + 1 reserved）──
pub const CONTEXT_LENGTH_EXCEEDED: &str = "context.length_exceeded";
pub const CONTEXT_COMPACTION_FAILED: &str = "context.compaction_failed";
pub const CONTEXT_HEAL_FAILED: &str = "context.heal_failed";
// ── tool 域（10 正式码；原 7 + 中断/取消/未知 3，session-integrity-repair 02 §4.1）──
pub const TOOL_NOT_FOUND: &str = "tool.not_found";
pub const TOOL_INVALID_INPUT: &str = "tool.invalid_input";
pub const TOOL_EXECUTION_FAILED: &str = "tool.execution_failed";
pub const TOOL_PATH_ESCAPE: &str = "tool.path_escape";
pub const TOOL_VERSION_CONFLICT: &str = "tool.version_conflict";
/// 写入路径越权（T-D-08 硬沙箱：目标不在 run 级写允许集内，
/// `WritePathPolicy::Allowed` 白名单前缀之外——权限沙箱拒绝，与互斥冲突
/// `tool.write_path_conflict` 语义独立，一先一后串行叠加）
pub const TOOL_WRITE_NOT_ALLOWED: &str = "tool.write_not_allowed";
/// 写路径互斥冲突（I4-M3 写路径互斥：同一路径被其他持有者声明，
/// 与越权拒绝 tool.write_not_allowed 语义独立——白名单放行但被占用
/// 仍返回本码。F8-02：由 agent-tools 局部码并入注册表）
pub const TOOL_WRITE_PATH_CONFLICT: &str = "tool.write_path_conflict";
/// 工具在派发执行前被用户取消或控制意图终止（SP-1 / 流末尾中断；
/// session-integrity-repair 02 §4.1 F01）
pub const TOOL_ABORTED_BEFORE_DISPATCH: &str = "tool.aborted_before_dispatch";
/// 工具在执行批次中因兄弟工具失败或级联取消而被终止
pub const TOOL_CANCELLED: &str = "tool.cancelled";
/// 进程异常退出或冷启动恢复时检测到未决工具调用，结果不可知（自愈修复）
pub const TOOL_OUTCOME_UNKNOWN: &str = "tool.outcome_unknown";
// ── browser 域（9 正式码，17 文档 §1.3 + R-9-2/R-8/U-12）──
/// 浏览器恢复中（R-9-2：进程启动/崩溃重启期间工具不可用，可重试）
pub const TOOL_BROWSER_NOT_READY: &str = "tool.browser.not_ready";
/// 域名门禁拦截（17 §4：白名单/黑名单/IP 阻断，不可重试）
pub const TOOL_BROWSER_GATE_BLOCKED: &str = "tool.browser.gate_blocked";
/// 能力未开启（17 §2.3：evaluate/upload/剪贴板能力位默认关闭）
pub const TOOL_BROWSER_CAPABILITY_DISABLED: &str = "tool.browser.capability_disabled";
/// 快照版本失效（R-1：页面已变更，需重拍快照后重试）
pub const TOOL_BROWSER_STALE_SNAPSHOT: &str = "tool.browser.stale_snapshot";
/// 元素已过期（节点消失/重建，需重拍快照后重试）
pub const TOOL_BROWSER_NODE_GONE: &str = "tool.browser.node_gone";
/// 浏览器动作已取消（用户接管/急停吊销，不计入重试额度）
pub const TOOL_BROWSER_CANCELLED: &str = "tool.browser.cancelled";
/// evaluate 被拒（17 §3：白名单外求值，不可重试）
pub const TOOL_BROWSER_EVAL_FORBIDDEN: &str = "tool.browser.eval_forbidden";
/// 标签数量超限（15 MAX_TABS 上限，不可重试）
pub const TOOL_BROWSER_TAB_LIMIT_EXCEEDED: &str = "tool.browser.tab_limit_exceeded";
/// 浏览器能力未接线（引擎侧未注入会话，P1 接线后消除）
pub const TOOL_BROWSER_UNWIRED: &str = "tool.browser.unwired";
// ── computer 域（8 正式码，06 文档 §5 码表 + 04/18 文档语义）──
/// 参数非法（04 §2.1 / 18 §2.1：枚举/取值/组合合法性校验失败）
pub const TOOL_COMPUTER_INVALID_PARAMS: &str = "tool.computer.invalid_params";
/// 坐标越界（18 §4.4 API 空间边界校验失败；含 zoom region 越界）
pub const TOOL_COMPUTER_COORDS_OUT_OF_BOUNDS: &str = "tool.computer.coords_out_of_bounds";
/// 提权窗口拒绝（18 §9 R3 / 05 文档 gate：UI-PIA 会话隔离，注入受限，不静默失败）
pub const TOOL_COMPUTER_ELEVATED_WINDOW: &str = "tool.computer.elevated_window";
/// 会话未开启/已挂起（运行期动作准入拒绝，零副作用；挂载后禁用兜底）
pub const TOOL_COMPUTER_NOT_ENABLED: &str = "tool.computer.not_enabled";
/// 电脑操作会话未注入/恢复期（工具面 gating，对齐 browser 的 not_ready 语义）
pub const TOOL_COMPUTER_NOT_READY: &str = "tool.computer.not_ready";
/// 急停/取消（全局急停或会话级中止令牌触发，04 §4.3）
pub const TOOL_COMPUTER_CANCELLED: &str = "tool.computer.cancelled";
/// 能力缺失（UIA+视觉双通道皆无 → 拒绝启用，18 §3.4 降级矩阵第 4 格）
pub const TOOL_COMPUTER_CAPABILITY_UNAVAILABLE: &str = "tool.computer.capability_unavailable";
/// 未接线（骨架阶段占位；实施轮接线后消除，对齐 browser 的 unwired 先例）
pub const TOOL_COMPUTER_UNWIRED: &str = "tool.computer.unwired";
// ── mcp 域（3 正式码）──
pub const MCP_CONNECTION_FAILED: &str = "mcp.connection_failed";
pub const MCP_PROTOCOL_VIOLATION: &str = "mcp.protocol_violation";
pub const MCP_SERVER_NOT_FOUND: &str = "mcp.server_not_found";
// ── store 域（4 正式码）──
pub const STORE_WRITE_FAILED: &str = "store.write_failed";
pub const STORE_READ_FAILED: &str = "store.read_failed";
pub const STORE_CORRUPTED: &str = "store.corrupted";
pub const STORE_CAPACITY_EXCEEDED: &str = "store.capacity_exceeded";
// ── subagent 域（3 正式码 + 1 reserved）──
pub const SUBAGENT_DEPTH_EXCEEDED: &str = "subagent.depth_exceeded";
pub const SUBAGENT_DEADLOCK_DETECTED: &str = "subagent.deadlock_detected";
/// 嵌套禁止（T-D-02，用户裁决 REQ-D08：仅主 Agent 可派发子 Agent；
/// 子 Agent 内调用 run_subagent 一律拒绝——新语义单独登记，不复用
/// depth_exceeded 避免前端文案歧义）
pub const SUBAGENT_NESTING_DENIED: &str = "subagent.nesting_denied";
/// 子代理不存在（D4 D-5：kill_subagent 等单目标操作的 NotFound 结构化
/// 错误码——会话内 (session_id, agent_id) 主键定位失败，工具层与命令层共用）
pub const SUBAGENT_NOT_FOUND: &str = "subagent.not_found";
pub const SUBAGENT_TIMEOUT: &str = "subagent.timeout";
// ── plugin 域（3 正式码）──
pub const PLUGIN_NOT_FOUND: &str = "plugin.not_found";
pub const PLUGIN_ACTIVATION_FAILED: &str = "plugin.activation_failed";
pub const PLUGIN_PERMISSION_DENIED: &str = "plugin.permission_denied";
// ── approval 域（2 reserved 码）──
pub const APPROVAL_TIMEOUT: &str = "approval.timeout";
pub const APPROVAL_REJECTED: &str = "approval.rejected";
// ── event_store 域（4 正式码）──
pub const EVENT_STORE_APPEND_FAILED: &str = "event_store.append_failed";
pub const EVENT_STORE_CONSISTENCY_VIOLATION: &str = "event_store.consistency_violation";
pub const EVENT_STORE_READ_FAILED: &str = "event_store.read_failed";
pub const EVENT_STORE_DEGRADED: &str = "event_store.degraded";
// ── artifact 域（2 正式码）──
pub const ARTIFACT_NOT_FOUND: &str = "artifact.not_found";
pub const ARTIFACT_INVALID_URI: &str = "artifact.invalid_uri";
// ── run 域（3 正式码）──
pub const RUN_NOT_FOUND: &str = "run.not_found";
pub const RUN_INVALID_STATE: &str = "run.invalid_state";
pub const RUN_NOT_GOAL_RUN: &str = "run.not_goal_run";
// ── network 域（1 正式码 + 1 reserved）──
pub const NETWORK_UNREACHABLE: &str = "network.unreachable";
pub const NETWORK_DAEMON_DEAD: &str = "network.daemon_dead";
// ── telemetry 域（1 正式码 + 2 reserved，含 log.write_failed）──
pub const TELEMETRY_EXPORT_FAILED: &str = "telemetry.export_failed";
pub const TELEMETRY_TRACE_LOST: &str = "telemetry.trace_lost";
pub const LOG_WRITE_FAILED: &str = "log.write_failed";
// ── common 域（5 正式码，PE-03 T03.3 新增 invalid_input / encoding）──
pub const COMMON_UNKNOWN: &str = "common.unknown";
pub const COMMON_UNSUPPORTED: &str = "common.unsupported";
pub const COMMON_NOT_FOUND: &str = "common.not_found";
pub const COMMON_INVALID_INPUT: &str = "common.invalid_input";
pub const COMMON_ENCODING: &str = "common.encoding";
// ── store 域（5 正式码，PE-03 T03.3 新增 io）──
pub const STORE_IO: &str = "store.io";
// ── security 域（1 正式码）──
pub const SECURITY_SSRF_REJECTED: &str = "security.ssrf_rejected";
// ── goal 域（3 正式码，R6 新增）──
pub const GOAL_STALLED: &str = "goal.stalled";
pub const GOAL_LOOP_DETECTED: &str = "goal.loop_detected";
pub const GOAL_MAX_ROUNDS: &str = "goal.max_rounds";
