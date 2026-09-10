//! CrishError 错误系统（TS 端 shared-types/src/errors 同构）
//!
//! 权威定义：
//! - analysis/iterative-repair/v2/ROUND-10-rust.md §3
//! - packages/shared-types/src/errors/{codes,info,classes,serialize}.ts
//! - 03-ERROR-MIGRATION.md §2.2（码表）/ §6（IPC 序列化）
//!
//! 设计要点：
//! - CrishError 用 struct 而非 enum（102 码跨 20 域，enum 不可维护）
//! - 错误码通过 codes 模块常量 + CRISH_ERROR_REGISTRY 静态注册表表达
//! - CrishErrorPayload 是 IPC 序列化类型，字段与 TS 端 CrishErrorPayload 一一对应
//! - cause 链递归深度上限 8（CRISH_ERROR_CAUSE_MAX_DEPTH）

use crate::session::{AgentEndReason, AgentSessionEvent};
use crate::CoreError;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

/// cause 链递归深度上限（TS 端 CRISH_ERROR_CAUSE_MAX_DEPTH = 8 同值）
pub const CRISH_ERROR_CAUSE_MAX_DEPTH: u8 = 8;

/// 故障类别（TS 端 CrishErrorCategory 同构，serde lowercase）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CrishErrorCategory {
    /// 可重试错误（网络、限流）
    Transient,
    /// 不可重试错误（非法输入、未找到）
    Permanent,
    /// 权限/鉴权错误
    Security,
    /// IPC/协议违规
    Protocol,
}

/// 错误码元信息（TS 端 CrishErrorInfo 同构）
#[derive(Debug, Clone, PartialEq)]
pub struct CrishErrorInfo {
    pub code: &'static str,
    pub title: &'static str,
    pub category: CrishErrorCategory,
    pub retryable: bool,
    pub is_public: bool,
    pub action: &'static str,
}

/// 错误码常量集（TS 端 CrishErrorCode 同构，102 码 / 20 域）
///
/// 来源：packages/shared-types/src/errors/codes.ts
/// 权威：03-ERROR-MIGRATION.md §2.2
pub mod codes {
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
    // ── tool 域（7 正式码）──
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
}

/// 错误码元信息注册表（TS 端 CRISH_ERROR_REGISTRY 同构，102 条）
static CRISH_ERROR_REGISTRY: Lazy<HashMap<&'static str, CrishErrorInfo>> = Lazy::new(|| {
    let mut m = HashMap::with_capacity(102);
    // ── config 域 ──
    m.insert(
        codes::CONFIG_INVALID,
        CrishErrorInfo {
            code: codes::CONFIG_INVALID,
            title: "配置项非法",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.config.check_field",
        },
    );
    m.insert(
        codes::CONFIG_MISSING,
        CrishErrorInfo {
            code: codes::CONFIG_MISSING,
            title: "配置缺失",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.config.provide_value",
        },
    );
    m.insert(
        codes::CONFIG_PARSE_FAILED,
        CrishErrorInfo {
            code: codes::CONFIG_PARSE_FAILED,
            title: "配置解析失败",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.config.verify_syntax",
        },
    );
    // ── session 域 ──
    m.insert(
        codes::SESSION_NOT_FOUND,
        CrishErrorInfo {
            code: codes::SESSION_NOT_FOUND,
            title: "会话未找到",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.session.select_existing",
        },
    );
    m.insert(
        codes::SESSION_INVALID_SESSION,
        CrishErrorInfo {
            code: codes::SESSION_INVALID_SESSION,
            title: "会话数据非法",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.session.restart",
        },
    );
    m.insert(
        codes::SESSION_INVALID_ENTRY,
        CrishErrorInfo {
            code: codes::SESSION_INVALID_ENTRY,
            title: "会话条目非法",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.session.check_entry",
        },
    );
    m.insert(
        codes::SESSION_INVALID_STATE,
        CrishErrorInfo {
            code: codes::SESSION_INVALID_STATE,
            title: "会话状态非法",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.session.refresh",
        },
    );
    m.insert(
        codes::SESSION_STORAGE_FAILED,
        CrishErrorInfo {
            code: codes::SESSION_STORAGE_FAILED,
            title: "会话存储失败",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.session.retry_save",
        },
    );
    m.insert(
        codes::SESSION_REWIND_FAILED,
        CrishErrorInfo {
            code: codes::SESSION_REWIND_FAILED,
            title: "会话回滚失败",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.session.check_rewind_target",
        },
    );
    // 跨线共享码（S3 ActivationGate 互斥守卫，browser_* 与 computer_* 共用；
    // 06 文档 §5 码表：登记归属 session 域，等待会话切换）
    m.insert(
        codes::TOOL_SESSION_EXCLUSIVE,
        CrishErrorInfo {
            code: codes::TOOL_SESSION_EXCLUSIVE,
            title: "会话互斥",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.session.wait_switch",
        },
    );
    // ── agent 域 ──
    m.insert(
        codes::AGENT_MAX_TURNS_REACHED,
        CrishErrorInfo {
            code: codes::AGENT_MAX_TURNS_REACHED,
            title: "达到最大轮次",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.agent.increase_max_turns",
        },
    );
    m.insert(
        codes::AGENT_NO_PROGRESS,
        CrishErrorInfo {
            code: codes::AGENT_NO_PROGRESS,
            title: "Agent 无进展",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.agent.intervene",
        },
    );
    m.insert(
        codes::AGENT_INTERVENTION_REQUIRED,
        CrishErrorInfo {
            code: codes::AGENT_INTERVENTION_REQUIRED,
            title: "需用户介入",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.agent.review",
        },
    );
    // ── runtime 域 ──
    m.insert(
        codes::RUNTIME_UNEXPECTED_STATE,
        CrishErrorInfo {
            code: codes::RUNTIME_UNEXPECTED_STATE,
            title: "运行时状态异常",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.runtime.restart_session",
        },
    );
    m.insert(
        codes::RUNTIME_TRANSITION_FAILED,
        CrishErrorInfo {
            code: codes::RUNTIME_TRANSITION_FAILED,
            title: "状态转移失败",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.runtime.report_bug",
        },
    );
    m.insert(
        codes::RUNTIME_ABORTED,
        CrishErrorInfo {
            code: codes::RUNTIME_ABORTED,
            title: "用户中止",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.runtime.none",
        },
    );
    m.insert(
        codes::RUNTIME_TIMEOUT,
        CrishErrorInfo {
            code: codes::RUNTIME_TIMEOUT,
            title: "运行时超时",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.runtime.retry",
        },
    );
    // ── provider 域 ──
    m.insert(
        codes::PROVIDER_NETWORK,
        CrishErrorInfo {
            code: codes::PROVIDER_NETWORK,
            title: "网络故障",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.provider.check_network",
        },
    );
    m.insert(
        codes::PROVIDER_GATEWAY_CHALLENGE,
        CrishErrorInfo {
            code: codes::PROVIDER_GATEWAY_CHALLENGE,
            title: "网关质询拦截",
            category: CrishErrorCategory::Protocol,
            retryable: false,
            is_public: true,
            action: "action.provider.disable_proxy",
        },
    );
    m.insert(
        codes::PROVIDER_RATE_LIMIT,
        CrishErrorInfo {
            code: codes::PROVIDER_RATE_LIMIT,
            title: "限流",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.provider.wait_retry",
        },
    );
    m.insert(
        codes::PROVIDER_AUTH,
        CrishErrorInfo {
            code: codes::PROVIDER_AUTH,
            title: "鉴权失败",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.provider.check_api_key",
        },
    );
    m.insert(
        codes::PROVIDER_QUOTA,
        CrishErrorInfo {
            code: codes::PROVIDER_QUOTA,
            title: "配额耗尽",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.provider.top_up",
        },
    );
    m.insert(
        codes::PROVIDER_ENDPOINT_UNAVAILABLE,
        CrishErrorInfo {
            code: codes::PROVIDER_ENDPOINT_UNAVAILABLE,
            title: "端点不可用",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.provider.check_endpoint",
        },
    );
    m.insert(
        codes::PROVIDER_SCHEMA,
        CrishErrorInfo {
            code: codes::PROVIDER_SCHEMA,
            title: "请求 schema 非法",
            category: CrishErrorCategory::Protocol,
            retryable: false,
            is_public: true,
            action: "action.provider.fix_request",
        },
    );
    m.insert(
        codes::PROVIDER_SERVER,
        CrishErrorInfo {
            code: codes::PROVIDER_SERVER,
            title: "服务端错误",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.provider.wait_retry",
        },
    );
    m.insert(
        codes::PROVIDER_TIMEOUT,
        CrishErrorInfo {
            code: codes::PROVIDER_TIMEOUT,
            title: "请求超时",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.provider.retry",
        },
    );
    m.insert(
        codes::PROVIDER_CANCELLED,
        CrishErrorInfo {
            code: codes::PROVIDER_CANCELLED,
            title: "请求取消",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: false,
            action: "action.runtime.none",
        },
    );
    m.insert(
        codes::PROVIDER_STREAM_INTERRUPTED,
        CrishErrorInfo {
            code: codes::PROVIDER_STREAM_INTERRUPTED,
            title: "流中断",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.provider.retry",
        },
    );
    m.insert(
        codes::PROVIDER_UNKNOWN,
        CrishErrorInfo {
            code: codes::PROVIDER_UNKNOWN,
            title: "未知 Provider 错误",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.provider.report_bug",
        },
    );
    m.insert(
        codes::PROVIDER_CONNECTION_ERROR,
        CrishErrorInfo {
            code: codes::PROVIDER_CONNECTION_ERROR,
            title: "Provider 连接错误",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.provider.check_connection",
        },
    );
    m.insert(
        codes::PROVIDER_NO_TOKEN,
        CrishErrorInfo {
            code: codes::PROVIDER_NO_TOKEN,
            title: "OAuth 令牌缺失",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.provider.reauth",
        },
    );
    m.insert(
        codes::PROVIDER_REAUTH_REQUIRED,
        CrishErrorInfo {
            code: codes::PROVIDER_REAUTH_REQUIRED,
            title: "需重新鉴权",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.provider.reauth",
        },
    );
    m.insert(
        codes::PROVIDER_FATAL,
        CrishErrorInfo {
            code: codes::PROVIDER_FATAL,
            title: "Provider 不可恢复错误",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.provider.report_bug",
        },
    );
    m.insert(
        codes::PROVIDER_REFRESH_FAILED,
        CrishErrorInfo {
            code: codes::PROVIDER_REFRESH_FAILED,
            title: "令牌刷新失败",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.provider.reauth",
        },
    );
    // ── context 域 ──
    m.insert(
        codes::CONTEXT_LENGTH_EXCEEDED,
        CrishErrorInfo {
            code: codes::CONTEXT_LENGTH_EXCEEDED,
            title: "上下文超长",
            category: CrishErrorCategory::Protocol,
            retryable: true,
            is_public: true,
            action: "action.context.compact",
        },
    );
    m.insert(
        codes::CONTEXT_COMPACTION_FAILED,
        CrishErrorInfo {
            code: codes::CONTEXT_COMPACTION_FAILED,
            title: "上下文压缩失败",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.context.retry_compact",
        },
    );
    m.insert(
        codes::CONTEXT_HEAL_FAILED,
        CrishErrorInfo {
            code: codes::CONTEXT_HEAL_FAILED,
            title: "上下文修复失败",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.context.manual_trim",
        },
    );
    // ── tool 域 ──
    m.insert(
        codes::TOOL_NOT_FOUND,
        CrishErrorInfo {
            code: codes::TOOL_NOT_FOUND,
            title: "工具未找到",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.tool.check_name",
        },
    );
    m.insert(
        codes::TOOL_INVALID_INPUT,
        CrishErrorInfo {
            code: codes::TOOL_INVALID_INPUT,
            title: "工具入参非法",
            category: CrishErrorCategory::Protocol,
            retryable: false,
            is_public: true,
            action: "action.tool.fix_input",
        },
    );
    m.insert(
        codes::TOOL_EXECUTION_FAILED,
        CrishErrorInfo {
            code: codes::TOOL_EXECUTION_FAILED,
            title: "工具执行失败",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.tool.retry",
        },
    );
    m.insert(
        codes::TOOL_PATH_ESCAPE,
        CrishErrorInfo {
            code: codes::TOOL_PATH_ESCAPE,
            title: "路径越界",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.tool.check_path",
        },
    );
    m.insert(
        codes::TOOL_VERSION_CONFLICT,
        CrishErrorInfo {
            code: codes::TOOL_VERSION_CONFLICT,
            title: "文档版本冲突",
            category: CrishErrorCategory::Protocol,
            retryable: false,
            is_public: true,
            action: "action.tool.refresh_and_retry",
        },
    );
    // T-D-08（REQ-D04 硬沙箱）：越权写拒绝——Permanent/不可重试（确定拒绝，
    // 目标路径与允许范围在错误消息载荷中，可指引调整或走权限申请通道）
    m.insert(
        codes::TOOL_WRITE_NOT_ALLOWED,
        CrishErrorInfo {
            code: codes::TOOL_WRITE_NOT_ALLOWED,
            title: "写入路径不在允许范围内",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.tool.request_path_allowance",
        },
    );
    // F8-02（I4-M3 写路径互斥）：并发互斥冲突——Permanent/不可重试（确定拒绝，
    // 等待占用者释放后由主 agent 编排串行重试；错误消息载荷含占用者/时间/有效期）。
    // 与 write_not_allowed 语义独立：白名单放行但被占用仍返回本码
    m.insert(
        codes::TOOL_WRITE_PATH_CONFLICT,
        CrishErrorInfo {
            code: codes::TOOL_WRITE_PATH_CONFLICT,
            title: "写入路径互斥冲突",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.tool.wait_retry",
        },
    );
    // ── browser 域（9 正式码：17 文档 §1.3，R-9-2/R-8/U-12 语义）──
    // R-9-2：恢复期工具门禁——Transient/可重试（等待恢复完成重试）
    m.insert(
        codes::TOOL_BROWSER_NOT_READY,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_NOT_READY,
            title: "浏览器恢复中",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.browser.wait_recovery",
        },
    );
    // 17 §4：域名门禁拦截——Permanent/不可重试（策略拒绝，需改目标域）
    m.insert(
        codes::TOOL_BROWSER_GATE_BLOCKED,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_GATE_BLOCKED,
            title: "域名门禁拦截",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.browser.check_domain",
        },
    );
    // 17 §2.3：能力位默认关闭——Security/不可重试（需显式开启）
    m.insert(
        codes::TOOL_BROWSER_CAPABILITY_DISABLED,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_CAPABILITY_DISABLED,
            title: "能力未开启",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.browser.enable_capability",
        },
    );
    // R-1：快照版本失效——Transient/可重试（重拍快照后重试）
    m.insert(
        codes::TOOL_BROWSER_STALE_SNAPSHOT,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_STALE_SNAPSHOT,
            title: "快照版本失效",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.browser.refresh_snapshot",
        },
    );
    // 节点过期——Transient/可重试（重拍快照后重试）
    m.insert(
        codes::TOOL_BROWSER_NODE_GONE,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_NODE_GONE,
            title: "元素已过期",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.browser.refresh_snapshot",
        },
    );
    // R-8：用户接管/急停吊销——Permanent/不可重试（不计入重试额度，编排层重试）
    m.insert(
        codes::TOOL_BROWSER_CANCELLED,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_CANCELLED,
            title: "浏览器动作已取消",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: false,
            action: "action.browser.none",
        },
    );
    // 17 §3：evaluate 白名单外——Security/不可重试
    m.insert(
        codes::TOOL_BROWSER_EVAL_FORBIDDEN,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_EVAL_FORBIDDEN,
            title: "evaluate 被拒",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.browser.check_eval_policy",
        },
    );
    // 15 MAX_TABS 上限——Permanent/不可重试
    m.insert(
        codes::TOOL_BROWSER_TAB_LIMIT_EXCEEDED,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_TAB_LIMIT_EXCEEDED,
            title: "标签数量超限",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.browser.close_tabs",
        },
    );
    // P1 接线前——Permanent/不可重试（引擎侧接线后消除）
    m.insert(
        codes::TOOL_BROWSER_UNWIRED,
        CrishErrorInfo {
            code: codes::TOOL_BROWSER_UNWIRED,
            title: "浏览器能力未接线",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.browser.check_supported",
        },
    );
    // ── computer 域（8 正式码：06 文档 §5 码表语义 + 任务分类裁决）──
    // 参数非法——Permanent/不可重试（模型修参后重试，非自动重试）
    m.insert(
        codes::TOOL_COMPUTER_INVALID_PARAMS,
        CrishErrorInfo {
            code: codes::TOOL_COMPUTER_INVALID_PARAMS,
            title: "参数非法",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.computer.fix_input",
        },
    );
    // 坐标越界——Permanent/不可重试（模型需取新感知）
    m.insert(
        codes::TOOL_COMPUTER_COORDS_OUT_OF_BOUNDS,
        CrishErrorInfo {
            code: codes::TOOL_COMPUTER_COORDS_OUT_OF_BOUNDS,
            title: "坐标越界",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.computer.refresh_perception",
        },
    );
    // 提权窗口——Security/不可重试（UI-PIA 会话隔离，需用户手动操作）
    m.insert(
        codes::TOOL_COMPUTER_ELEVATED_WINDOW,
        CrishErrorInfo {
            code: codes::TOOL_COMPUTER_ELEVATED_WINDOW,
            title: "提权窗口拒绝",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.computer.manual_operation",
        },
    );
    // 会话未开启——Permanent/不可重试（需用户重新显式开启）
    m.insert(
        codes::TOOL_COMPUTER_NOT_ENABLED,
        CrishErrorInfo {
            code: codes::TOOL_COMPUTER_NOT_ENABLED,
            title: "会话未开启",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.computer.enable_session",
        },
    );
    // 会话未就绪——Transient/可重试（等待会话注入/恢复完成）
    m.insert(
        codes::TOOL_COMPUTER_NOT_READY,
        CrishErrorInfo {
            code: codes::TOOL_COMPUTER_NOT_READY,
            title: "电脑会话未就绪",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.computer.wait_retry",
        },
    );
    // 急停/取消——Permanent/不可重试（对齐 browser.cancelled，不计入重试额度）
    m.insert(
        codes::TOOL_COMPUTER_CANCELLED,
        CrishErrorInfo {
            code: codes::TOOL_COMPUTER_CANCELLED,
            title: "电脑操作已取消",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: false,
            action: "action.computer.none",
        },
    );
    // 能力缺失——Security/不可重试（UIA+视觉双通道皆无，缺依赖）
    m.insert(
        codes::TOOL_COMPUTER_CAPABILITY_UNAVAILABLE,
        CrishErrorInfo {
            code: codes::TOOL_COMPUTER_CAPABILITY_UNAVAILABLE,
            title: "能力不可用",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.computer.check_capability",
        },
    );
    // 未接线——Permanent/不可重试（骨架占位，实施轮接线后消除）
    m.insert(
        codes::TOOL_COMPUTER_UNWIRED,
        CrishErrorInfo {
            code: codes::TOOL_COMPUTER_UNWIRED,
            title: "电脑能力未接线",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.computer.check_supported",
        },
    );
    // ── mcp 域 ──
    m.insert(
        codes::MCP_CONNECTION_FAILED,
        CrishErrorInfo {
            code: codes::MCP_CONNECTION_FAILED,
            title: "MCP 连接失败",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.mcp.check_server",
        },
    );
    m.insert(
        codes::MCP_PROTOCOL_VIOLATION,
        CrishErrorInfo {
            code: codes::MCP_PROTOCOL_VIOLATION,
            title: "MCP 协议违规",
            category: CrishErrorCategory::Protocol,
            retryable: false,
            is_public: true,
            action: "action.mcp.report_bug",
        },
    );
    m.insert(
        codes::MCP_SERVER_NOT_FOUND,
        CrishErrorInfo {
            code: codes::MCP_SERVER_NOT_FOUND,
            title: "MCP 服务器未找到",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.mcp.check_config",
        },
    );
    // ── store 域 ──
    m.insert(
        codes::STORE_WRITE_FAILED,
        CrishErrorInfo {
            code: codes::STORE_WRITE_FAILED,
            title: "存储写入失败",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.store.retry_write",
        },
    );
    m.insert(
        codes::STORE_IO,
        CrishErrorInfo {
            code: codes::STORE_IO,
            title: "存储/IO 失败",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.store.retry_write",
        },
    );
    m.insert(
        codes::STORE_READ_FAILED,
        CrishErrorInfo {
            code: codes::STORE_READ_FAILED,
            title: "存储读取失败",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.store.retry_read",
        },
    );
    m.insert(
        codes::STORE_CORRUPTED,
        CrishErrorInfo {
            code: codes::STORE_CORRUPTED,
            title: "存储数据损坏",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.store.restore_backup",
        },
    );
    m.insert(
        codes::STORE_CAPACITY_EXCEEDED,
        CrishErrorInfo {
            code: codes::STORE_CAPACITY_EXCEEDED,
            title: "存储容量超限",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.store.cleanup_or_expand",
        },
    );
    // ── subagent 域 ──
    m.insert(
        codes::SUBAGENT_DEPTH_EXCEEDED,
        CrishErrorInfo {
            code: codes::SUBAGENT_DEPTH_EXCEEDED,
            title: "子代理递归深度超限",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.subagent.reduce_depth",
        },
    );
    m.insert(
        codes::SUBAGENT_DEADLOCK_DETECTED,
        CrishErrorInfo {
            code: codes::SUBAGENT_DEADLOCK_DETECTED,
            title: "子代理死锁",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.subagent.break_cycle",
        },
    );
    m.insert(
        codes::SUBAGENT_NESTING_DENIED,
        CrishErrorInfo {
            code: codes::SUBAGENT_NESTING_DENIED,
            title: "子代理嵌套禁止",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.subagent.ask_main_agent",
        },
    );
    m.insert(
        codes::SUBAGENT_NOT_FOUND,
        CrishErrorInfo {
            code: codes::SUBAGENT_NOT_FOUND,
            title: "子代理不存在",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.subagent.verify_id",
        },
    );
    m.insert(
        codes::SUBAGENT_TIMEOUT,
        CrishErrorInfo {
            code: codes::SUBAGENT_TIMEOUT,
            title: "子代理超时",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.subagent.retry",
        },
    );
    // ── plugin 域 ──
    m.insert(
        codes::PLUGIN_NOT_FOUND,
        CrishErrorInfo {
            code: codes::PLUGIN_NOT_FOUND,
            title: "插件未找到",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.plugin.check_install",
        },
    );
    m.insert(
        codes::PLUGIN_ACTIVATION_FAILED,
        CrishErrorInfo {
            code: codes::PLUGIN_ACTIVATION_FAILED,
            title: "插件激活失败",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.plugin.check_manifest",
        },
    );
    m.insert(
        codes::PLUGIN_PERMISSION_DENIED,
        CrishErrorInfo {
            code: codes::PLUGIN_PERMISSION_DENIED,
            title: "插件权限不足",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: true,
            action: "action.plugin.grant_permission",
        },
    );
    // ── approval 域 ──
    m.insert(
        codes::APPROVAL_TIMEOUT,
        CrishErrorInfo {
            code: codes::APPROVAL_TIMEOUT,
            title: "审批超时",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.approval.resubmit",
        },
    );
    m.insert(
        codes::APPROVAL_REJECTED,
        CrishErrorInfo {
            code: codes::APPROVAL_REJECTED,
            title: "审批被拒",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.approval.modify_request",
        },
    );
    // ── event_store 域 ──
    m.insert(
        codes::EVENT_STORE_APPEND_FAILED,
        CrishErrorInfo {
            code: codes::EVENT_STORE_APPEND_FAILED,
            title: "事件追加失败",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: false,
            action: "action.event_store.retry_append",
        },
    );
    m.insert(
        codes::EVENT_STORE_CONSISTENCY_VIOLATION,
        CrishErrorInfo {
            code: codes::EVENT_STORE_CONSISTENCY_VIOLATION,
            title: "事件一致性违规",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: false,
            action: "action.event_store.rebuild_index",
        },
    );
    m.insert(
        codes::EVENT_STORE_READ_FAILED,
        CrishErrorInfo {
            code: codes::EVENT_STORE_READ_FAILED,
            title: "事件读取失败",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: false,
            action: "action.event_store.retry_read",
        },
    );
    m.insert(
        codes::EVENT_STORE_DEGRADED,
        CrishErrorInfo {
            code: codes::EVENT_STORE_DEGRADED,
            title: "事件存储降级",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: false,
            action: "action.event_store.check_disk",
        },
    );
    // ── artifact 域 ──
    m.insert(
        codes::ARTIFACT_NOT_FOUND,
        CrishErrorInfo {
            code: codes::ARTIFACT_NOT_FOUND,
            title: "Artifact 未找到",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.artifact.check_uri",
        },
    );
    m.insert(
        codes::ARTIFACT_INVALID_URI,
        CrishErrorInfo {
            code: codes::ARTIFACT_INVALID_URI,
            title: "Artifact URI 非法",
            category: CrishErrorCategory::Protocol,
            retryable: false,
            is_public: true,
            action: "action.artifact.fix_uri",
        },
    );
    // ── run 域 ──
    m.insert(
        codes::RUN_NOT_FOUND,
        CrishErrorInfo {
            code: codes::RUN_NOT_FOUND,
            title: "Run 未找到",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.run.select_existing",
        },
    );
    m.insert(
        codes::RUN_INVALID_STATE,
        CrishErrorInfo {
            code: codes::RUN_INVALID_STATE,
            title: "Run 状态非法",
            category: CrishErrorCategory::Protocol,
            retryable: false,
            is_public: true,
            action: "action.run.refresh",
        },
    );
    m.insert(
        codes::RUN_NOT_GOAL_RUN,
        CrishErrorInfo {
            code: codes::RUN_NOT_GOAL_RUN,
            title: "非 Goal Run",
            category: CrishErrorCategory::Protocol,
            retryable: false,
            is_public: true,
            action: "action.run.use_goal_run",
        },
    );
    // ── network 域 ──
    m.insert(
        codes::NETWORK_UNREACHABLE,
        CrishErrorInfo {
            code: codes::NETWORK_UNREACHABLE,
            title: "网络不可达",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: true,
            action: "action.network.check_connection",
        },
    );
    m.insert(
        codes::NETWORK_DAEMON_DEAD,
        CrishErrorInfo {
            code: codes::NETWORK_DAEMON_DEAD,
            title: "后台 Daemon 已死",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.network.restart_daemon",
        },
    );
    // ── telemetry 域（含 log.write_failed）──
    m.insert(
        codes::TELEMETRY_EXPORT_FAILED,
        CrishErrorInfo {
            code: codes::TELEMETRY_EXPORT_FAILED,
            title: "观测数据导出失败",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: false,
            action: "action.telemetry.retry_export",
        },
    );
    m.insert(
        codes::TELEMETRY_TRACE_LOST,
        CrishErrorInfo {
            code: codes::TELEMETRY_TRACE_LOST,
            title: "Trace 丢失",
            // Trace 已丢失不可恢复：retryable 与 action 对齐为 Permanent/none
            //（原 Transient/retryable=true + action.none 自相矛盾）
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: false,
            action: "action.telemetry.none",
        },
    );
    m.insert(
        codes::LOG_WRITE_FAILED,
        CrishErrorInfo {
            code: codes::LOG_WRITE_FAILED,
            title: "日志写入失败",
            category: CrishErrorCategory::Transient,
            retryable: true,
            is_public: false,
            action: "action.log.retry_write",
        },
    );
    // ── common 域 ──
    m.insert(
        codes::COMMON_UNKNOWN,
        CrishErrorInfo {
            code: codes::COMMON_UNKNOWN,
            title: "未知错误",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.common.report_bug",
        },
    );
    m.insert(
        codes::COMMON_UNSUPPORTED,
        CrishErrorInfo {
            code: codes::COMMON_UNSUPPORTED,
            title: "不支持的操作",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.common.check_version",
        },
    );
    m.insert(
        codes::COMMON_NOT_FOUND,
        CrishErrorInfo {
            code: codes::COMMON_NOT_FOUND,
            title: "通用资源未找到",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.common.check_resource",
        },
    );
    m.insert(
        codes::COMMON_INVALID_INPUT,
        CrishErrorInfo {
            code: codes::COMMON_INVALID_INPUT,
            title: "参数非法",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.common.check_field",
        },
    );
    m.insert(
        codes::COMMON_ENCODING,
        CrishErrorInfo {
            code: codes::COMMON_ENCODING,
            title: "编解码失败",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.common.check_encoding",
        },
    );
    // ── security 域 ──
    m.insert(
        codes::SECURITY_SSRF_REJECTED,
        CrishErrorInfo {
            code: codes::SECURITY_SSRF_REJECTED,
            title: "SSRF 拦截",
            category: CrishErrorCategory::Security,
            retryable: false,
            is_public: false,
            action: "action.security.check_target",
        },
    );
    // ── goal 域 ──
    m.insert(
        codes::GOAL_STALLED,
        CrishErrorInfo {
            code: codes::GOAL_STALLED,
            title: "Goal 循环停滞",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.goal.review_progress",
        },
    );
    m.insert(
        codes::GOAL_LOOP_DETECTED,
        CrishErrorInfo {
            code: codes::GOAL_LOOP_DETECTED,
            title: "Goal 循环签名重复",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.goal.break_loop",
        },
    );
    m.insert(
        codes::GOAL_MAX_ROUNDS,
        CrishErrorInfo {
            code: codes::GOAL_MAX_ROUNDS,
            title: "Goal 达到最大轮次",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.goal.increase_max_rounds",
        },
    );
    m
});

/// 查询错误码元信息，未知码回退到 common.unknown（TS 端 getErrorInfo 同构）
pub fn info(code: &str) -> CrishErrorInfo {
    CRISH_ERROR_REGISTRY
        .get(code)
        .cloned()
        .unwrap_or(CrishErrorInfo {
            code: codes::COMMON_UNKNOWN,
            title: "未知错误",
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.common.report_bug",
        })
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Crish 错误类型（struct，非 enum）
///
/// Crish 错误类型（struct，非 enum），与 TS 端 CrishError class 同构。
/// 102 码通过 code: String 表达，
/// category/retryable 由 info(code) 在构造时决定，可通过 with_* 覆盖。
/// cause 链在 to_error_payload 时按 depth 截断。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CrishError {
    pub code: String,
    pub message: String,
    pub category: CrishErrorCategory,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<Box<CrishError>>,
    pub timestamp: i64,
}

impl CrishError {
    /// 创建错误，category/retryable 由 info(code) 决定
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        let info = info(code);
        Self {
            code: code.into(),
            message: message.into(),
            category: info.category,
            retryable: info.retryable,
            metadata: None,
            cause: None,
            timestamp: now_millis(),
        }
    }

    /// 覆盖 category（对齐 §2.1 设计原则 3：retryable 与 category 解耦）
    pub fn with_category(mut self, category: CrishErrorCategory) -> Self {
        self.category = category;
        self
    }

    /// 覆盖 retryable
    pub fn with_retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    /// 附加 metadata
    pub fn with_metadata(mut self, metadata: serde_json::Value) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// 附加 cause（构建因果链）
    pub fn with_cause(mut self, cause: CrishError) -> Self {
        self.cause = Some(Box::new(cause));
        self
    }

    /// 是否可重试（直接返回字段值，不重新查询 registry）
    pub fn is_retryable(&self) -> bool {
        self.retryable
    }

    /// 序列化为 IPC 负载，cause 链在 depth >= 8 时截断
    /// （TS 端 toErrorPayload 同构，截断 payload 携带 metadata.truncated = true）
    pub fn to_error_payload(&self, depth: u8) -> CrishErrorPayload {
        if depth >= CRISH_ERROR_CAUSE_MAX_DEPTH {
            return CrishErrorPayload {
                code: codes::COMMON_UNKNOWN.to_string(),
                message: format!("cause chain truncated at depth {depth}"),
                category: CrishErrorCategory::Permanent,
                retryable: false,
                is_public: false,
                action: "action.runtime.none".to_string(),
                metadata: Some(serde_json::json!({ "truncated": true })),
                cause: None,
                stack: None,
                timestamp: now_millis(),
            };
        }
        let info_val = info(&self.code);
        CrishErrorPayload {
            code: self.code.clone(),
            message: self.message.clone(),
            category: self.category,
            retryable: self.retryable,
            is_public: info_val.is_public,
            action: info_val.action.to_string(),
            metadata: self.metadata.clone(),
            cause: self
                .cause
                .as_ref()
                .map(|c| Box::new(c.to_error_payload(depth + 1))),
            stack: None, // Rust 端无 JS stack，置 None；前端从 cause 链还原
            timestamp: self.timestamp,
        }
    }
}

/// 跨进程序列化错误负载（TS 端 CrishErrorPayload 同构）
///
/// 字段一一对应 packages/shared-types/src/errors/serialize.ts 的 CrishErrorPayload：
/// code / message / category / retryable / public / action / metadata / cause / stack / timestamp
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CrishErrorPayload {
    pub code: String,
    pub message: String,
    pub category: CrishErrorCategory,
    pub retryable: bool,
    /// 序列化为 "public"（TS 端字段名同值）
    #[serde(rename = "public")]
    pub is_public: bool,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cause: Option<Box<CrishErrorPayload>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    pub timestamp: i64,
}

impl CrishErrorPayload {
    /// 从任意 std::error::Error 构造兜底 payload（TS 端 fromUnknownError 同构）
    ///
    /// 若 e 已是 CrishError，直接 to_error_payload(0)；否则用 common.unknown 兜底。
    /// 要求 `'static` 是为了支持 downcast_ref（标准模式，与 anyhow/std 一致）。
    pub fn from_unknown(e: &(dyn std::error::Error + 'static)) -> Self {
        if let Some(c) = e.downcast_ref::<CrishError>() {
            return c.to_error_payload(0);
        }
        CrishErrorPayload {
            code: codes::COMMON_UNKNOWN.to_string(),
            message: e.to_string(),
            category: CrishErrorCategory::Permanent,
            retryable: false,
            is_public: true,
            action: "action.common.report_bug".to_string(),
            metadata: None,
            cause: None,
            stack: None,
            timestamp: now_millis(),
        }
    }

    /// 是否可重试
    pub fn is_retryable(&self) -> bool {
        self.retryable
    }
}

// ── ProviderErrorKind 分类（02 §4.2 分类表 13 行逐行对齐）──

/// Provider 错误分类（02-provider-semantics.md §4.2 分类表 13 行，
/// 判定优先级从上到下；shared-types 的 ProviderErrorKind 12 值 +
/// payload-too-large/context-length-exceeded 拆分后为 13 类）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderErrorKind {
    /// 第 1 行：signal.aborted / AbortError，底层 USER_ABORT，不可重试
    Aborted,
    /// 第 2 行：HTTP 413 请求体过大（payload_too_large），不可重试
    PayloadTooLarge,
    /// 第 3 行：Cloudflare 质询（cf-mitigated / cf_chl / "just a moment"），不可重试
    GatewayChallenge,
    /// 第 4 行：HTTP 401/403 或 unauthorized/forbidden/invalid api key，不可重试
    Auth,
    /// 第 5 行：HTTP 402 或 insufficient quota / out of credits，不可重试
    Quota,
    /// 第 6 行：HTTP 404/405/415 端点不可用，不可重试
    EndpointUnavailable,
    /// 第 7 行：HTTP 400/422 且上下文超长（唯一可重试的 4xx）
    ContextLengthExceeded,
    /// 第 8 行：HTTP 400/422 其余（含 payload too large 消息），不可重试
    InvalidRequest,
    /// 第 9 行：HTTP 429 或 rate limit 字样，可重试（携带 retryAfterMs）
    RateLimit,
    /// 第 10 行：HTTP 500/502/503/504/520/522/523/524 等，可重试
    ServerError,
    /// 第 11 行：消息含 timeout/timed out，可重试
    Timeout,
    /// 第 12 行：连接失败/流中断等传输层错误（02 §五.11 裁决必须可重试）
    Network,
    /// 第 13 行：兜底未知错误，不可重试
    Unknown,
}

impl ProviderErrorKind {
    /// 02 §4.2 默认 retryable 矩阵（provider-error-classifier.ts:31-38）
    pub fn default_retryable(self) -> bool {
        matches!(
            self,
            ProviderErrorKind::ContextLengthExceeded
                | ProviderErrorKind::RateLimit
                | ProviderErrorKind::ServerError
                | ProviderErrorKind::Timeout
                | ProviderErrorKind::Network
        )
    }

    /// 映射到 error.rs 既有错误码（对齐 TS migrateErrorCode §3.3）
    pub fn code(self) -> &'static str {
        match self {
            ProviderErrorKind::Aborted => codes::PROVIDER_CANCELLED,
            ProviderErrorKind::PayloadTooLarge => codes::PROVIDER_SCHEMA,
            ProviderErrorKind::GatewayChallenge => codes::PROVIDER_GATEWAY_CHALLENGE,
            ProviderErrorKind::Auth => codes::PROVIDER_AUTH,
            ProviderErrorKind::Quota => codes::PROVIDER_QUOTA,
            ProviderErrorKind::EndpointUnavailable => codes::PROVIDER_ENDPOINT_UNAVAILABLE,
            ProviderErrorKind::ContextLengthExceeded => codes::CONTEXT_LENGTH_EXCEEDED,
            ProviderErrorKind::InvalidRequest => codes::PROVIDER_SCHEMA,
            ProviderErrorKind::RateLimit => codes::PROVIDER_RATE_LIMIT,
            ProviderErrorKind::ServerError => codes::PROVIDER_SERVER,
            ProviderErrorKind::Timeout => codes::PROVIDER_TIMEOUT,
            ProviderErrorKind::Network => codes::PROVIDER_NETWORK,
            ProviderErrorKind::Unknown => codes::PROVIDER_UNKNOWN,
        }
    }
}

// ── 旧错误码迁移（对齐 TS migrateErrorCode，normalize.ts 全表 + 附录 B）──

/// 旧码迁移上下文（对齐 normalize.ts 的 context 参数）
#[derive(Debug, Clone, Copy, Default)]
pub struct MigrateErrorContext<'a> {
    /// TOOL_ERROR / ARTIFACT_ERROR / ADAPTER_ERROR 的拆分方向
    pub kind: Option<&'a str>,
    /// CLIENT_INVALID_INPUT 的 context_length_exceeded 判定
    pub sub_type: Option<&'a str>,
}

/// 旧错误码 → 新 CrishErrorCode 映射
///
/// 覆盖 SessionErrorCode、ProviderErrorKind、自由字符串码
/// （含 NO_PROVIDER→config.missing、RUN_ERROR→runtime.unexpected_state）、
/// TOOL_ERROR 拆分、ErrorDomain 枚举。未知名回退 common.unknown。
pub fn migrate_error_code(legacy_code: &str, context: MigrateErrorContext) -> &'static str {
    // ── SessionErrorCode（normalize.ts §3.1）──
    match legacy_code {
        "not_found" => return codes::SESSION_NOT_FOUND,
        "invalid_session" => return codes::SESSION_INVALID_SESSION,
        "invalid_entry" => return codes::SESSION_INVALID_ENTRY,
        "invalid_state" => return codes::SESSION_INVALID_STATE,
        "storage" => return codes::SESSION_STORAGE_FAILED,
        _ => {}
    }
    // ── ProviderErrorKind（normalize.ts §3.3）──
    match legacy_code {
        "network" => return codes::PROVIDER_NETWORK,
        "gateway-challenge" => return codes::PROVIDER_GATEWAY_CHALLENGE,
        "rate-limit" => return codes::PROVIDER_RATE_LIMIT,
        "auth" => return codes::PROVIDER_AUTH,
        "quota" => return codes::PROVIDER_QUOTA,
        "endpoint-unavailable" => return codes::PROVIDER_ENDPOINT_UNAVAILABLE,
        "schema" => return codes::PROVIDER_SCHEMA,
        "server" => return codes::PROVIDER_SERVER,
        "timeout" => return codes::PROVIDER_TIMEOUT,
        "cancelled" => return codes::PROVIDER_CANCELLED,
        "invalid-stream" => return codes::PROVIDER_STREAM_INTERRUPTED,
        "unknown" => return codes::PROVIDER_UNKNOWN,
        _ => {}
    }
    // ── 自由字符串码（normalize.ts §3.4 + 附录 B）──
    match legacy_code {
        "NO_PROVIDER" => return codes::CONFIG_MISSING,
        "RUN_ERROR" => return codes::RUNTIME_UNEXPECTED_STATE,
        "CONFIG_ERROR" => return codes::CONFIG_INVALID,
        "CHECKPOINT_ERROR" | "BOUNDARY_ERROR" | "SCOPED_CONTEXT_ERROR" => {
            return codes::STORE_CORRUPTED;
        }
        "ARTIFACT_ERROR" => {
            return if context.kind == Some("not_found") {
                codes::ARTIFACT_NOT_FOUND
            } else {
                codes::ARTIFACT_INVALID_URI
            };
        }
        "ADAPTER_ERROR" => {
            return if context.kind == Some("not_found") {
                codes::ARTIFACT_NOT_FOUND
            } else {
                codes::STORE_CORRUPTED
            };
        }
        "DAEMON_DEAD" | "DAEMON_ERROR" => return codes::NETWORK_DAEMON_DEAD,
        "NETWORK_ERROR" => return codes::PROVIDER_NETWORK,
        "INVALID_RUN_STATE" => return codes::RUN_INVALID_STATE,
        "NOT_A_GOAL_RUN" => return codes::RUN_NOT_GOAL_RUN,
        _ => {}
    }
    // ── TOOL_ERROR 按 context.kind 拆分（49 处 → 4 码）──
    if legacy_code == "TOOL_ERROR" {
        return match context.kind {
            Some("path") => codes::TOOL_PATH_ESCAPE,
            Some("input") => codes::TOOL_INVALID_INPUT,
            Some("not_found") => codes::TOOL_NOT_FOUND,
            _ => codes::TOOL_EXECUTION_FAILED,
        };
    }
    // ── ErrorDomain 枚举值（normalize.ts §3.2）──
    match legacy_code {
        "USER_ABORT" => codes::RUNTIME_ABORTED,
        "TRANSIENT_NETWORK" => codes::PROVIDER_NETWORK,
        "TRANSIENT_SERVER" => codes::PROVIDER_SERVER,
        "RATE_LIMIT" => codes::PROVIDER_RATE_LIMIT,
        "CLIENT_AUTH" => codes::PROVIDER_AUTH,
        "CLIENT_INVALID_INPUT" => {
            if context.sub_type == Some("context_length_exceeded") {
                codes::CONTEXT_LENGTH_EXCEEDED
            } else {
                codes::PROVIDER_SCHEMA
            }
        }
        "QUOTA_EXHAUSTED" => codes::PROVIDER_QUOTA,
        "STREAM_INTERRUPT" => codes::PROVIDER_STREAM_INTERRUPTED,
        "ENDPOINT_UNAVAILABLE" => codes::PROVIDER_ENDPOINT_UNAVAILABLE,
        "GATEWAY_CHALLENGE" => codes::PROVIDER_GATEWAY_CHALLENGE,
        "UNKNOWN" => codes::COMMON_UNKNOWN,
        _ => codes::COMMON_UNKNOWN,
    }
}

// ── RunTerminal 收口决策类型（01 §五.2）──

/// run 结束决策约束错误
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RunTerminalError {
    /// 非 error 收场不得携带 error（01 §1.6：error 最小集合约束）
    #[error("非 error 收场不得携带 error（reason={0:?}）")]
    ErrorNotAllowed(AgentEndReason),
    /// error 收场必须携带 error
    #[error("error 收场必须携带 error")]
    MissingError,
    /// 事件不属于 01 §1.6 错误收场四事件
    #[error("事件 {0:?} 不属于 01 §1.6 错误收场四事件")]
    NotErrorEvent(AgentSessionEvent),
}

/// run 收口决策类型（01 §五.2：单一 `{reason, error?}` 决策收敛所有收场路径）
///
/// - reason=Error 仅由 01 §1.6 四个事件产生（ERROR / INTERVENTION_REQUIRED /
///   PROVIDER_ERROR / STEERING_BUDGET_EXHAUSTED），且必须携带 error；
/// - 其余 reason 不得携带 error。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunTerminal {
    pub reason: AgentEndReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<CrishError>,
}

impl RunTerminal {
    /// 构造收口决策：仅 reason=Error 允许携带 error
    pub fn new(
        reason: AgentEndReason,
        error: Option<CrishError>,
    ) -> Result<Self, RunTerminalError> {
        match (reason, error) {
            (AgentEndReason::Error, Some(error)) => Ok(Self {
                reason,
                error: Some(error),
            }),
            (AgentEndReason::Error, None) => Err(RunTerminalError::MissingError),
            (other, Some(_)) => Err(RunTerminalError::ErrorNotAllowed(other)),
            (other, None) => Ok(Self {
                reason: other,
                error: None,
            }),
        }
    }

    /// 由 01 §1.6 四个错误收场事件构造（其他事件一律拒绝）
    pub fn from_error_event(
        event: AgentSessionEvent,
        error: CrishError,
    ) -> Result<Self, RunTerminalError> {
        match event {
            AgentSessionEvent::Error
            | AgentSessionEvent::InterventionRequired
            | AgentSessionEvent::ProviderError
            | AgentSessionEvent::SteeringBudgetExhausted => Ok(Self {
                reason: AgentEndReason::Error,
                error: Some(error),
            }),
            other => Err(RunTerminalError::NotErrorEvent(other)),
        }
    }

    /// 是否错误收场
    pub fn is_error(&self) -> bool {
        self.reason == AgentEndReason::Error
    }
}

// ── CoreError → 78 码显式映射（PE-03 T03.3 动作 1，AU-04 D8 边界）──
//
// IPC 面唯一协议为 CoreError `{kind, detail}`；web 网关 HTTP 层需要 78 码时，
// 一律经本函数显式映射（单一真源，禁止散落 map_err）。映射表见
// PE-03 §2.4.2（Q30：`From<CoreError> for CrishError` 类型删除归 PE-06 T06.5.4，
// 本函数只做显式映射，不落类型删除）。

/// 把 `CoreError` 映射为 78 码体系主码（PE-03 §2.4.2 映射表成文）。
///
/// | CoreError kind | 78 码主码 | 说明 |
/// |---|---|---|
/// | InvalidInput | common.invalid_input | 参数校验失败 |
/// | Encoding | common.encoding | 编解码失败 |
/// | Io | store.io | 存储/IO 失败（detail 携带操作名） |
/// | NotFound | common.not_found | 资源缺失 |
/// | Cancelled | runtime.aborted | 取消 |
/// | Internal | common.unknown | 兜底（detail 必填原始错误） |
pub fn core_error_code(err: &CoreError) -> &'static str {
    match err {
        CoreError::InvalidInput(_) => codes::COMMON_INVALID_INPUT,
        CoreError::Encoding(_) => codes::COMMON_ENCODING,
        CoreError::Io(_) => codes::STORE_IO,
        CoreError::NotFound(_) => codes::COMMON_NOT_FOUND,
        CoreError::Cancelled => codes::RUNTIME_ABORTED,
        CoreError::Internal(_) => codes::COMMON_UNKNOWN,
    }
}

// ── From 转换（共存阶段，禁令 23：CoreError 保留，添加无损映射）──
// 对齐 03-ERROR-MIGRATION.md §3.5 Rust CoreError → CrishErrorCode 映射表。

/// Q30 显式工厂：从 CoreError 显式构造 CrishError（AA-01 Q30 修复——
/// 删除 `From<CoreError> for CrishError` 的隐式兜底映射，改由调用方按
/// 码表选码）。
///
/// `invalid_input_code` 由调用方按上下文选择精确码（如 `tool.invalid_input`、
/// `session.invalid_session` 等），不再有语义存疑的 `InvalidInput →
/// common.unsupported` 猜测映射。
pub fn from_core_error_with_context(
    err: CoreError,
    invalid_input_code: &'static str,
) -> CrishError {
    // 主码一律经 core_error_code 单一真源（PE-03 §2.4.2 映射表，12-T-PD-07）：
    // 双入口（core_error_code / from_core_error_with_context）共用同一映射，
    // 禁止散落 map_err 猜测映射（AU-04 D8 边界）。
    //
    // 语义备案（32 文档 DD3-T7）：Encoding 从 store.corrupted 切至
    // common.encoding——未来调用方如需「编码损坏」语义须显式走
    // STORE_CORRUPTED；Io 从 store.write_failed 切至 store.io——无方向
    // 信息时主码兜底，方向性分流仍由 map_io_err 承担。码值均已注册，
    // conex-types 与 TS 共享码表无双端同步需求。
    let code = core_error_code(&err);
    match err {
        // Q30 契约：InvalidInput 由调用方按上下文选精确码（如
        // tool.invalid_input、session.invalid_session），不走主码兜底
        CoreError::InvalidInput(msg) => CrishError::new(invalid_input_code, msg),
        CoreError::Encoding(msg) => CrishError::new(code, msg),
        CoreError::Io(msg) => CrishError::new(code, msg),
        CoreError::NotFound(msg) => {
            // 主码 common.not_found（单一真源）+ legacyKind 标记保留：
            // 兼容旧 IPC 消费方按 kind 分支的路径
            CrishError::new(code, msg)
                .with_metadata(serde_json::json!({ "legacyKind": "NotFound" }))
        }
        CoreError::Cancelled => CrishError::new(code, "cancelled"),
        CoreError::Internal(msg) => CrishError::new(code, msg),
    }
}

impl From<CrishError> for CrishErrorPayload {
    fn from(e: CrishError) -> Self {
        e.to_error_payload(0)
    }
}

impl std::fmt::Display for CrishError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CrishError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.cause
            .as_ref()
            .map(|c| c.as_ref() as &(dyn std::error::Error + 'static))
    }
}

// ===== Tests =====

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_error_payload_roundtrip() {
        let err = CrishError::new(codes::STORE_WRITE_FAILED, "disk full")
            .with_metadata(serde_json::json!({ "path": "/tmp/db" }));
        let payload = err.to_error_payload(0);
        assert_eq!(payload.code, "store.write_failed");
        assert_eq!(payload.message, "disk full");
        assert_eq!(payload.category, CrishErrorCategory::Transient);
        assert!(payload.retryable);
        assert_eq!(
            payload.metadata,
            Some(serde_json::json!({ "path": "/tmp/db" }))
        );
        // JSON roundtrip
        let json = serde_json::to_string(&payload).unwrap();
        let back: CrishErrorPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(payload, back);
    }

    #[test]
    fn payload_serializes_to_camel_case_and_public_field() {
        let err = CrishError::new(codes::TOOL_PATH_ESCAPE, "escape attempt");
        let payload = err.to_error_payload(0);
        let json = serde_json::to_value(&payload).unwrap();
        // is_public 序列化为 "public"
        assert_eq!(json["public"], true);
        // category 序列化为 lowercase
        assert_eq!(json["category"], "security");
        // action 字段存在
        assert_eq!(json["action"], "action.tool.check_path");
        // timestamp 存在
        assert!(json["timestamp"].is_i64());
    }

    #[test]
    fn cause_chain_truncation_at_depth_8() {
        // 构建 10 层 cause 链：depth0 -> depth1 -> ... -> depth9
        let mut err = CrishError::new(codes::COMMON_UNKNOWN, "depth 9");
        for i in (0..9).rev() {
            err = CrishError::new(codes::COMMON_UNKNOWN, format!("depth {i}")).with_cause(err);
        }
        let payload = err.to_error_payload(0);
        // 遍历 cause 链，统计到达截断层的深度
        let mut current = &payload;
        let mut depth = 0u8;
        while let Some(cause) = &current.cause {
            current = cause;
            depth += 1;
        }
        // 第 8 层为截断 payload
        assert_eq!(depth, CRISH_ERROR_CAUSE_MAX_DEPTH);
        assert_eq!(current.code, codes::COMMON_UNKNOWN);
        assert!(current.message.contains("truncated"));
        assert_eq!(
            current.metadata.as_ref().and_then(|m| m.get("truncated")),
            Some(&serde_json::json!(true))
        );
    }

    #[test]
    fn from_core_error_invalid_input() {
        // Q30：显式工厂——调用方按码表选码（此处示范 tool.invalid_input），
        // 不再走 common.unsupported 隐式兜底
        let err = from_core_error_with_context(
            CoreError::InvalidInput("bad input".into()),
            codes::TOOL_INVALID_INPUT,
        );
        assert_eq!(err.code, codes::TOOL_INVALID_INPUT);
        assert_eq!(err.category, CrishErrorCategory::Protocol);
        assert!(!err.is_retryable());
    }

    #[test]
    fn from_core_error_cancelled() {
        let err = from_core_error_with_context(CoreError::Cancelled, codes::COMMON_UNSUPPORTED);
        assert_eq!(err.code, codes::RUNTIME_ABORTED);
        assert_eq!(err.category, CrishErrorCategory::Permanent);
        assert!(!err.is_retryable());
    }

    #[test]
    fn from_core_error_not_found_carries_legacy_kind() {
        let err = from_core_error_with_context(
            CoreError::NotFound("missing".into()),
            codes::COMMON_UNSUPPORTED,
        );
        // 12-T-PD-07：NotFound 主码按单一真源切至 common.not_found
        // （原兜底 common.unknown 随之统一），legacyKind 标记保留
        assert_eq!(err.code, codes::COMMON_NOT_FOUND);
        assert_eq!(
            err.metadata.as_ref().and_then(|m| m.get("legacyKind")),
            Some(&serde_json::json!("NotFound"))
        );
    }

    #[test]
    fn from_unknown_std_error() {
        let io_err = std::io::Error::other("something broke");
        let payload = CrishErrorPayload::from_unknown(&io_err);
        assert_eq!(payload.code, codes::COMMON_UNKNOWN);
        assert_eq!(payload.category, CrishErrorCategory::Permanent);
        assert!(!payload.is_retryable());
        assert!(payload.message.contains("something broke"));
    }

    #[test]
    fn from_unknown_downcasts_crish_error() {
        let crish = CrishError::new(codes::STORE_CORRUPTED, "db corrupted");
        let payload = CrishErrorPayload::from_unknown(&crish);
        assert_eq!(payload.code, codes::STORE_CORRUPTED);
        assert_eq!(payload.category, CrishErrorCategory::Permanent);
    }

    #[test]
    fn unknown_code_falls_back_to_common_unknown() {
        let info_val = info("nonexistent.code");
        assert_eq!(info_val.code, codes::COMMON_UNKNOWN);
        assert_eq!(info_val.category, CrishErrorCategory::Permanent);
    }

    // ── T-D-08：tool.write_not_allowed 登记断言 ──

    /// 硬沙箱错误码已登记：Permanent / 不可重试 / 文案含「写入路径」。
    #[test]
    fn write_not_allowed_registered() {
        let info_val = info(codes::TOOL_WRITE_NOT_ALLOWED);
        assert_eq!(info_val.code, codes::TOOL_WRITE_NOT_ALLOWED);
        assert_eq!(info_val.category, CrishErrorCategory::Permanent);
        assert!(!info_val.retryable, "越权写为确定拒绝，不可重试");
        assert!(info_val.is_public, "越权拒绝必须对前端可见（编排用）");
        assert!(
            info_val.title.contains("写入路径"),
            "文案「写入路径不在允许范围内」"
        );
        // 构造错误：category/retryable 由注册表派生，payload 出站正确
        let err = CrishError::new(codes::TOOL_WRITE_NOT_ALLOWED, "目标不在允许范围");
        assert_eq!(err.code, codes::TOOL_WRITE_NOT_ALLOWED);
        assert_eq!(err.category, CrishErrorCategory::Permanent);
        assert!(!err.is_retryable());
    }

    // ── F8-02：tool.write_path_conflict 登记断言（写路径互斥，agent-tools 局部码并入注册表）──

    /// 写路径互斥冲突码已登记：Permanent / 不可重试（确定拒绝，
    /// 等待占用者释放后由主 agent 编排重试），且对前端可见。
    #[test]
    fn write_path_conflict_registered() {
        let info_val = info(codes::TOOL_WRITE_PATH_CONFLICT);
        assert_eq!(info_val.code, codes::TOOL_WRITE_PATH_CONFLICT);
        assert_eq!(info_val.category, CrishErrorCategory::Permanent);
        assert!(!info_val.retryable, "互斥冲突为确定拒绝，不可自动重试");
        assert!(info_val.is_public, "冲突须对前端可见（编排串行需要）");
        assert!(info_val.title.contains("互斥"), "文案应含「互斥」");
        // 构造错误：category/retryable 由注册表派生，payload 出站正确
        let err = CrishError::new(codes::TOOL_WRITE_PATH_CONFLICT, "目标已被占用");
        assert_eq!(err.code, codes::TOOL_WRITE_PATH_CONFLICT);
        assert_eq!(err.category, CrishErrorCategory::Permanent);
        assert!(!err.is_retryable());
    }

    // ── S5：tool.computer.* 8 码 + tool.session.exclusive 登记断言（06 文档 §5 码表）──

    /// computer 域 8 码 + 跨线共享码 tool.session.exclusive 全部已登记，
    /// category/retryable/is_public 按 06 文档 §5 码表语义与任务分类裁决派生。
    #[test]
    fn computer_codes_registered() {
        let cases: [(&str, CrishErrorCategory, bool, bool); 9] = [
            // (码, category, retryable, is_public)
            (
                codes::TOOL_COMPUTER_INVALID_PARAMS,
                CrishErrorCategory::Permanent,
                false,
                true,
            ),
            (
                codes::TOOL_COMPUTER_COORDS_OUT_OF_BOUNDS,
                CrishErrorCategory::Permanent,
                false,
                true,
            ),
            (
                codes::TOOL_COMPUTER_ELEVATED_WINDOW,
                CrishErrorCategory::Security,
                false,
                true,
            ),
            (
                codes::TOOL_COMPUTER_NOT_ENABLED,
                CrishErrorCategory::Permanent,
                false,
                true,
            ),
            (
                codes::TOOL_COMPUTER_NOT_READY,
                CrishErrorCategory::Transient,
                true,
                true,
            ),
            (
                codes::TOOL_COMPUTER_CANCELLED,
                CrishErrorCategory::Permanent,
                false,
                false,
            ),
            (
                codes::TOOL_COMPUTER_CAPABILITY_UNAVAILABLE,
                CrishErrorCategory::Security,
                false,
                true,
            ),
            (
                codes::TOOL_COMPUTER_UNWIRED,
                CrishErrorCategory::Permanent,
                false,
                true,
            ),
            (
                codes::TOOL_SESSION_EXCLUSIVE,
                CrishErrorCategory::Permanent,
                false,
                true,
            ),
        ];
        for (code, category, retryable, is_public) in cases {
            let info_val = info(code);
            assert_eq!(info_val.code, code, "{code} 必须已登记");
            assert_eq!(info_val.category, category, "{code} category 不符");
            assert_eq!(info_val.retryable, retryable, "{code} retryable 不符");
            assert_eq!(info_val.is_public, is_public, "{code} is_public 不符");
            // 构造错误：category/retryable 由注册表派生，payload 出站正确
            let err = CrishError::new(code, "test");
            assert_eq!(err.code, code);
            assert_eq!(err.category, category);
            assert_eq!(err.is_retryable(), retryable);
        }
    }

    // ── PE-03 T03.3：core_error_code 显式映射（6 kind × 主码表 + 注册存在性）──    /// 6 个 kind 全部映射到 78 码体系主码（§2.4.2 映射表逐行断言）。
    #[test]
    fn core_error_code_maps_all_kinds() {
        assert_eq!(
            core_error_code(&CoreError::InvalidInput("x".into())),
            codes::COMMON_INVALID_INPUT
        );
        assert_eq!(
            core_error_code(&CoreError::Encoding("x".into())),
            codes::COMMON_ENCODING
        );
        assert_eq!(core_error_code(&CoreError::Io("x".into())), codes::STORE_IO);
        assert_eq!(
            core_error_code(&CoreError::NotFound("x".into())),
            codes::COMMON_NOT_FOUND
        );
        assert_eq!(
            core_error_code(&CoreError::Cancelled),
            codes::RUNTIME_ABORTED
        );
        assert_eq!(
            core_error_code(&CoreError::Internal("x".into())),
            codes::COMMON_UNKNOWN
        );
    }

    /// 映射出的主码必须存在于注册表（info 回查 code 一致），禁止映射到未登记码。
    #[test]
    fn core_error_code_targets_are_registered() {
        let samples = [
            CoreError::InvalidInput("x".into()),
            CoreError::Encoding("x".into()),
            CoreError::Io("x".into()),
            CoreError::NotFound("x".into()),
            CoreError::Cancelled,
            CoreError::Internal("x".into()),
        ];
        for err in samples {
            let code = core_error_code(&err);
            assert_eq!(
                info(code).code,
                code,
                "主码 {code} 必须已登记（info 回查一致）"
            );
        }
    }

    /// 主码唯一性：6 个 kind 不得共享同一主码（映射总覆盖 + 区分度）。
    #[test]
    fn core_error_code_primary_codes_are_unique() {
        let samples = [
            CoreError::InvalidInput("x".into()),
            CoreError::Encoding("x".into()),
            CoreError::Io("x".into()),
            CoreError::NotFound("x".into()),
            CoreError::Cancelled,
            CoreError::Internal("x".into()),
        ];
        let mut codes_seen: Vec<&'static str> = samples.iter().map(core_error_code).collect();
        let before = codes_seen.len();
        codes_seen.sort_unstable();
        codes_seen.dedup();
        assert_eq!(codes_seen.len(), before, "6 个 kind 的主码必须互不相同");
    }

    /// 双入口一致性（12-T-PD-07）：`from_core_error_with_context` 与
    /// `core_error_code` 对同一 kind 产出同一主码——双映射入口共用单一
    /// 真源，杜绝「core_error_code 说 common.encoding、上下文映射却说
    /// store.corrupted」的码分裂。InvalidInput 例外：Q30 契约由调用方
    /// 按上下文选精确码，传入主码本身时双入口一致（其余 5 种 kind 的
    /// 入参 "x" 被忽略，码走单一真源）。
    #[test]
    fn dual_mapping_entries_agree() {
        let kinds = [
            CoreError::InvalidInput("x".into()),
            CoreError::Encoding("x".into()),
            CoreError::Io("x".into()),
            CoreError::NotFound("x".into()),
            CoreError::Cancelled,
            CoreError::Internal("x".into()),
        ];
        for k in kinds {
            let expected = core_error_code(&k);
            let invalid_input_code = match k {
                CoreError::InvalidInput(_) => expected,
                _ => "x",
            };
            let mapped = from_core_error_with_context(k, invalid_input_code);
            assert_eq!(
                mapped.code, expected,
                "双入口对 kind 的主码必须一致（单一真源，禁止散落 map_err）"
            );
        }
    }

    #[test]
    fn crish_error_implements_std_error() {
        let cause = CrishError::new(codes::STORE_CORRUPTED, "root cause");
        let outer = CrishError::new(codes::COMMON_UNKNOWN, "wrapper").with_cause(cause);
        // Display
        assert_eq!(format!("{}", outer), "common.unknown: wrapper");
        // std::error::Error::source
        let src = std::error::Error::source(&outer);
        assert!(src.is_some());
        let src_msg = src.unwrap().to_string();
        assert!(src_msg.contains("store.corrupted"));
    }
}
