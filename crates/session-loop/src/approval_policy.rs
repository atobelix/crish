//! 审批策略引擎（ApprovalPolicyEngine）
//!
//! 承载全天候自主运行下的审批超时自适应求值：
//! 1. 动态计算指定审批请求的超时等待窗口（摆脱硬编码 120s）；
//! 2. 基于权限模式、工具危险度、运行模式与命令类别，在倒计时到期未决时求值超时动作：
//!    - `Allow`: 无人值守/低危工具，倒计时结束后自动放行；
//!    - `Deny { reason, guidance }`: 高危/破坏性命令，倒计时结束后自动拒绝并携带行动指引以保安全；
//!    - `Expire`: 需要人工核准的敏感操作，超时挂起。
//!
//! 铁律规范：
//! - 彻底删除 `system_wipe` 硬编码与 `write_output_file` 伪工具；
//! - 遵循单一真理源 (SSOT)；
//! - 严禁打补丁，面向未来，代码简洁。

use std::path::PathBuf;
use std::time::Duration;
use agent_tools::permission::PermissionMode;
use crate::tool_events::ApprovalRequester;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 倒计时超时策略动作枚举
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum TimeoutAction {
    /// 自动放行 (Fail-Open)
    /// 倒计时结束直接批准执行，无缝衔接，Agent 零感知推进
    Allow,

    /// 显式语义拒绝 (Fail-Closed with Guidance)
    /// 返回结构化拒绝原因与行动替代指引，指导 LLM 换路推进，阻断死循环
    Deny {
        /// 拒绝原因（告知用户或模型）
        reason: String,
        /// 行动指引（告知模型下一步应当如何做，严禁重复尝试本命令）
        #[serde(default, skip_serializing_if = "Option::is_none")]
        guidance: Option<String>,
    },

    /// 传统过期兜底 (Traditional Expire)
    /// 仅限危险级别最高且必须由人工在场裁决的生产级破坏性操作，安全挂起
    Expire,
}

/// 超时判定上下文
#[derive(Debug, Clone)]
pub struct TimeoutEvaluationContext<'a> {
    /// 工具名称 (如 "write_file", "shell", "git_commit")
    pub tool_name: &'a str,
    /// 工具调用参数
    pub args: &'a Value,
    /// 危险级别：0=安全/只读, 1=常规工作区写入, 2=高危/生产破坏, 3=Redline
    pub danger_level: u8,
    /// 会话标识
    pub session_id: &'a str,
    /// 运行标识
    pub run_id: &'a str,
    /// 请求方身份（子代理 run id + 任务类型 + 理由）
    pub requester: Option<&'a ApprovalRequester>,
    /// 当前生效的权限模式 (Ask / Smart / Full)
    pub permission_mode: PermissionMode,
    /// 是否开启全天候无人值守模式
    pub unattended_mode: bool,
    /// 工作区根目录路径
    pub workspace_root: Option<&'a PathBuf>,
    /// 申请理由
    pub reason: Option<&'a str>,
}

/// 审批与超时策略引擎 Trait
pub trait ApprovalPolicyEngine: Send + Sync {
    /// 动态计算指定审批请求的超时等待窗口
    fn resolve_timeout(&self, ctx: &TimeoutEvaluationContext<'_>) -> Duration;

    /// 当倒计时到达且未收到人工裁决时，求值决策动作
    fn evaluate_timeout_action(&self, ctx: &TimeoutEvaluationContext<'_>) -> TimeoutAction;
}

/// 策略引擎配置结构体（支持从 session_meta 或全局设置注入）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalPolicyConfig {
    /// 无人值守模式缺省超时（默认 60s）
    pub unattended_default_timeout_secs: u64,
    /// 有人盯盘模式缺省超时（默认 120s）
    pub attended_default_timeout_secs: u64,
    /// 允许无人值守自动放行的最大危险级别（默认 1，即 Level 1 及以下允许 Auto-Allow）
    pub max_auto_allow_danger_level: u8,
    /// 是否允许子代理写入工作区自动放行
    pub subagent_auto_allow_workspace_writes: bool,
}

impl Default for ApprovalPolicyConfig {
    fn default() -> Self {
        Self {
            unattended_default_timeout_secs: 60,
            attended_default_timeout_secs: 120,
            max_auto_allow_danger_level: 1,
            subagent_auto_allow_workspace_writes: true,
        }
    }
}

/// 缺省审批策略引擎实现
pub struct DefaultApprovalPolicyEngine {
    config: ApprovalPolicyConfig,
}

impl DefaultApprovalPolicyEngine {
    pub fn new(config: ApprovalPolicyConfig) -> Self {
        Self { config }
    }
}

impl Default for DefaultApprovalPolicyEngine {
    fn default() -> Self {
        Self::new(ApprovalPolicyConfig::default())
    }
}

/// 生成语义拒绝引导文案
pub fn generate_semantic_denial_message(
    tool_name: &str,
    reason: &str,
    guidance: Option<&str>,
) -> String {
    let base_guidance = guidance.unwrap_or(
        "【无人值守策略拒绝】当前操作因超出安全阈值且在倒计时内未获人工确认而被策略引擎自动拒绝。\n\
         【行动指引】\n\
         1. 严禁以完全相同或相似的参数重复调用此命令（避免陷入工具死循环）；\n\
         2. 请评估是否存在替代方案：例如使用只读检查工具收集现状、\n\
            将写操作范围缩减至工作区临时目录（.agent-outputs/）、或跳过本分支推进其他并行任务；\n\
         3. 继续完成其余既定目标，并在最终总结中向用户说明此操作被策略拒绝的情况。",
    );
    format!(
        "ToolExecutionDenied: 操作 '{tool_name}' 未获批准。\n原因: {reason}\n{base_guidance}"
    )
}

impl ApprovalPolicyEngine for DefaultApprovalPolicyEngine {
    fn resolve_timeout(&self, ctx: &TimeoutEvaluationContext<'_>) -> Duration {
        if ctx.unattended_mode {
            Duration::from_secs(self.config.unattended_default_timeout_secs)
        } else {
            Duration::from_secs(self.config.attended_default_timeout_secs)
        }
    }

    fn evaluate_timeout_action(&self, ctx: &TimeoutEvaluationContext<'_>) -> TimeoutAction {
        // 防线 1: 判定是否命中全局 Redline (绝对红线永不放行，由语义分析抽象统领，零特例硬编码)
        if ctx.danger_level >= 3 {
            return TimeoutAction::Deny {
                reason: "安全红线拦截：严禁执行破坏性高危操作".to_string(),
                guidance: Some("该操作命中安全红线已被策略引擎永久否决。请改用只读或无害化命令。".to_string()),
            };
        }

        // 防线 2: 判定是否处于无人值守模式 (Unattended Mode)
        if ctx.unattended_mode {
            // Level 1 及以下危险度：执行 Auto-Allow 自动放行
            if ctx.danger_level <= self.config.max_auto_allow_danger_level {
                tracing::info!(
                    target: "policy_engine",
                    tool = ctx.tool_name,
                    run_id = ctx.run_id,
                    danger_level = ctx.danger_level,
                    "无人值守模式：低危常规操作倒计时到达，策略引擎自动放行 (Auto-Allow)"
                );
                return TimeoutAction::Allow;
            }

            // 中高危写操作或破坏性命令：执行显式语义拒绝，引导模型换路自愈，避免停机
            tracing::warn!(
                target: "policy_engine",
                tool = ctx.tool_name,
                run_id = ctx.run_id,
                danger_level = ctx.danger_level,
                "无人值守模式：高危操作倒计时到达，策略引擎安全拒绝并引导换路 (Semantic Deny)"
            );
            return TimeoutAction::Deny {
                reason: format!("无人值守安全拦截：操作 '{}' 超出无人值守自决权限阈值。", ctx.tool_name),
                guidance: Some(
                    "【行动指引】\n\
                     1. 严禁以相同参数反复重试此工具调用；\n\
                     2. 请切换为只读分析（如使用 grep/read_file 调研）或寻求非破坏性替代路径；\n\
                     3. 继续执行其他子任务。".to_string(),
                ),
            };
        }

        // 人工在场模式下默认退化为 Expire (等待人工)
        TimeoutAction::Expire
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_timeout_modes() {
        let engine = DefaultApprovalPolicyEngine::default();
        let args = serde_json::json!({});
        let ctx_unattended = TimeoutEvaluationContext {
            tool_name: "write_file",
            args: &args,
            danger_level: 1,
            session_id: "s1",
            run_id: "r1",
            requester: None,
            permission_mode: PermissionMode::Smart,
            unattended_mode: true,
            workspace_root: None,
            reason: None,
        };
        assert_eq!(engine.resolve_timeout(&ctx_unattended), Duration::from_secs(60));

        let ctx_attended = TimeoutEvaluationContext {
            tool_name: "write_file",
            args: &args,
            danger_level: 1,
            session_id: "s1",
            run_id: "r1",
            requester: None,
            permission_mode: PermissionMode::Smart,
            unattended_mode: false,
            workspace_root: None,
            reason: None,
        };
        assert_eq!(engine.resolve_timeout(&ctx_attended), Duration::from_secs(120));
    }

    #[test]
    fn test_evaluate_redline() {
        let engine = DefaultApprovalPolicyEngine::default();
        let args = serde_json::json!({});
        let ctx = TimeoutEvaluationContext {
            tool_name: "rm_rf",
            args: &args,
            danger_level: 3,
            session_id: "s1",
            run_id: "r1",
            requester: None,
            permission_mode: PermissionMode::Smart,
            unattended_mode: true,
            workspace_root: None,
            reason: None,
        };
        match engine.evaluate_timeout_action(&ctx) {
            TimeoutAction::Deny { reason, guidance } => {
                assert!(reason.contains("安全红线拦截"));
                assert!(guidance.unwrap().contains("命中安全红线"));
            }
            other => panic!("预期 Deny，实际为 {:?}", other),
        }
    }

    #[test]
    fn test_unattended_auto_allow_low_danger() {
        let engine = DefaultApprovalPolicyEngine::default();
        let args = serde_json::json!({});
        let ctx = TimeoutEvaluationContext {
            tool_name: "write_file",
            args: &args,
            danger_level: 1,
            session_id: "s1",
            run_id: "r1",
            requester: None,
            permission_mode: PermissionMode::Smart,
            unattended_mode: true,
            workspace_root: None,
            reason: None,
        };
        assert_eq!(engine.evaluate_timeout_action(&ctx), TimeoutAction::Allow);
    }

    #[test]
    fn test_unattended_semantic_deny_high_danger() {
        let engine = DefaultApprovalPolicyEngine::default();
        let args = serde_json::json!({});
        let ctx = TimeoutEvaluationContext {
            tool_name: "destructive_tool",
            args: &args,
            danger_level: 2,
            session_id: "s1",
            run_id: "r1",
            requester: None,
            permission_mode: PermissionMode::Smart,
            unattended_mode: true,
            workspace_root: None,
            reason: None,
        };
        match engine.evaluate_timeout_action(&ctx) {
            TimeoutAction::Deny { reason, guidance } => {
                assert!(reason.contains("无人值守安全拦截"));
                assert!(guidance.unwrap().contains("严禁以相同参数反复重试"));
            }
            other => panic!("预期 Deny，实际为 {:?}", other),
        }
    }

    #[test]
    fn test_attended_expires() {
        let engine = DefaultApprovalPolicyEngine::default();
        let args = serde_json::json!({});
        let ctx = TimeoutEvaluationContext {
            tool_name: "write_file",
            args: &args,
            danger_level: 1,
            session_id: "s1",
            run_id: "r1",
            requester: None,
            permission_mode: PermissionMode::Smart,
            unattended_mode: false,
            workspace_root: None,
            reason: None,
        };
        assert_eq!(engine.evaluate_timeout_action(&ctx), TimeoutAction::Expire);
    }

    #[test]
    fn test_semantic_denial_message() {
        let msg = generate_semantic_denial_message("rm_rf", "高危操作", None);
        assert!(msg.contains("ToolExecutionDenied: 操作 'rm_rf' 未获批准"));
        assert!(msg.contains("原因: 高危操作"));
        assert!(msg.contains("【无人值守策略拒绝】"));
    }
}
