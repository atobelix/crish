//! config / session / agent / runtime / provider / context 域注册条目

use crate::error::{codes, CrishErrorCategory, CrishErrorInfo};
use std::collections::HashMap;

pub(super) fn register(m: &mut HashMap<&'static str, CrishErrorInfo>) {
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
}
