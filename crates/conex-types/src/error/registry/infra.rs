//! mcp / store / subagent / plugin / approval / event_store / artifact / run /
//! network / telemetry / common / security / goal 域注册条目

use crate::error::{codes, CrishErrorCategory, CrishErrorInfo};
use std::collections::HashMap;

pub(super) fn register(m: &mut HashMap<&'static str, CrishErrorInfo>) {
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
}
