//! 权限申请裁决者路由（T-D-14 权限传递层，用户定夺「子代理申请 → 主 agent
//! 裁决」的核心纯函数层）
//!
//! 三层模型（自上而下，裁决优先级：安全基线 > 默认集 > 显式覆盖 > 运行时申请）：
//! 第 3 层「运行时权限申请」= 本模块承载：`PermissionVerdict::NeedsApproval`
//! → 请求方身份（子代理 run + 父 run 归属）→ 裁决者路由（主 agent / 用户）
//! → 裁决（复用既有 ApprovalGate resolve 入口）。机制完全复用现有审批门，
//! 只改「谁裁决」（调研-权限传递层.md §2.3）。
//!
//! 本模块只含纯函数（来源分类 / 路由 / 请求方构造 / 理由提取 / 拒绝文案），
//! 可独立单测；不触达引擎状态。
//!
//! ## 死锁时序评审（开放问题 6.4，实现前评审，登记处理方式）
//!
//! 场景：主 agent 正在 wait 该子代理（`wait_subagents` 工具阻塞）时，子代理
//! 发起权限申请。
//!
//! ```text
//! 主 agent run（run-A）                子代理 run（run-B）
//! ────────────────                    ─────────────────
//! wait_subagents(run-B) 阻塞
//!                                     工具触发 NeedsApproval
//!                                      → 路由 Arbiter::MainAgent
//!                                      → 等待裁决（120s 超时）
//! （run-A 被 wait 阻塞，无法响应裁决通道）
//! ← 120s 超时：Expired 回子代理（run 不中断，approval_expired 非致命）
//! wait_subagents 返回 → 主 agent 释放
//! ```
//!
//! 评审结论：
//! 1. **无永久死锁**：超时兜底（`APPROVAL_TIMEOUT=120s`）保证申请必以
//!    Expired 收口；子代理 run 不中断（`ToolErrorKind::ApprovalExpired`
//!    is_never_fatal，审批类错误永不致命）；
//! 2. **120s 空等体验差**：主 agent 被 wait 阻塞期间既无法裁决也无法推进，
//!    → 路由层检测缓解：裁决者（主 agent）正在 wait 该子代理时**转用户**
//!    （[route_approval_guarded]）——用户裁决面不受主 agent wait 状态
//!    阻塞，可立即批准/拒绝，打破空等；
//! 3. **选「转用户」而非「自动拒绝」**：自动拒绝会静默阻断子代理的合法
//!    申请，且违背「拒绝需明确理由」的审计语义（approval-resolved 落库）；
//!    转用户保留裁决语义且与主 agent 状态解耦；
//! 4. **检测信号来源**：「主 agent 正在 wait 该子代理」= orchestrator 子
//!    代理跟踪器的 await 态（wait_subagents 工具执行期间标记）。当前引擎
//!    无该跟踪器（F11 T-D-13 引擎接线落地）；本模块提供纯函数路由契约 +
//!    workbench 侧 detector 注入槽（缺省 None = 退化为纯超时兜底，行为
//!    与现状一致）；
//! 5. **持久化待办不做**（开放问题 6.1，P2）：主 agent 离线时申请悬挂到
//!    超时；路由层预留「裁决方不在线 → 转用户兜底」分支（[Arbiter::User]
//!    即为兜底终点，UI 可裁决任何 run 的挂起审批）。

use serde_json::Value;

use crate::tool_events::ApprovalRequester;

/// 审批请求来源分类（裁决者路由依据）
///
/// 子代理身份判定 = 本 run id + 父 run 归属（`SubagentEmitContext.parent_run_id`
/// 语义：本 run 是谁 spawn 的）。父 run 缺失或为空串 = 视为主 agent run
/// （无父 run 兜底 User，数据异常不静默升级为主 agent 裁决）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalSource {
    /// 主 agent run（无父 run 归属）——裁决者 = 用户（现状不变）
    MainAgent,
    /// 子代理 run（有父 run 归属）——裁决者默认 = 主 agent
    Subagent {
        /// 请求方（子代理）run id
        run_id: String,
        /// 父 run id（裁决者 = 该 run）
        parent_run_id: String,
    },
}

/// 裁决者（审批请求的裁决归属）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Arbiter {
    /// 用户（UI 审批卡片；主 agent run 现状 + 子代理无父 run 兜底 +
    /// 死锁防护转用户）
    User,
    /// 主 agent（子代理申请新默认；裁决动作复用 core_approve_tool /
    /// core_deny_tool 的 resolve 入口，run id 参数指向子代理 run）
    MainAgent,
}

/// 来源分类：从「本 run id + 父 run 归属」判定审批请求来源。
///
/// - 父 run 为 Some 且非空 → [ApprovalSource::Subagent]；
/// - 父 run 缺失 / 空串（flow_graph 的 planner_run_id 缺省落空串）→
///   [ApprovalSource::MainAgent]（无父 run 兜底 User，不静默路由给主 agent）。
pub fn classify_source(run_id: &str, parent_run_id: Option<&str>) -> ApprovalSource {
    match parent_run_id.filter(|p| !p.is_empty()) {
        Some(parent_run_id) => ApprovalSource::Subagent {
            run_id: run_id.to_string(),
            parent_run_id: parent_run_id.to_string(),
        },
        None => ApprovalSource::MainAgent,
    }
}

/// 裁决者路由（主映射，调研 §2.3）：
/// MainAgent → User（现状不变）；Subagent → MainAgent（新默认）。
pub fn route_approval(source: &ApprovalSource) -> Arbiter {
    match source {
        ApprovalSource::MainAgent => Arbiter::User,
        ApprovalSource::Subagent { .. } => Arbiter::MainAgent,
    }
}

/// 死锁防护路由（开放问题 6.4）：裁决者（主 agent）正在 wait 该子代理时
/// 转用户兜底（用户裁决面不受主 agent wait 状态阻塞）。
///
/// `arbiter_waiting` = 裁决者 run 是否正在 wait 请求方 run（引擎侧经
/// detector 注入，缺省 false = 未检测到时按主路由）。
pub fn route_approval_guarded(source: &ApprovalSource, arbiter_waiting: bool) -> Arbiter {
    match source {
        ApprovalSource::MainAgent => Arbiter::User,
        ApprovalSource::Subagent { .. } if arbiter_waiting => Arbiter::User,
        ApprovalSource::Subagent { .. } => Arbiter::MainAgent,
    }
}

/// 从执行上下文构造请求方身份（T-D-14 任务书第 4 步）：
///
/// 子代理 run（有父 run 归属）→ Some（`run_id` = 子代理 run id + 申请理由）；
/// 主 agent run（无父 run 归属）→ None（裁决者 = 用户，既有 UI 审批流程）。
///
/// `task_type` 预留注入面（F11 T-D-13 spawner 装配；本任务恒 None——
/// 参数全 Option 兼容）。
pub fn requester_from_context(
    run_id: &str,
    parent_run_id: Option<&str>,
    reason: Option<String>,
) -> Option<ApprovalRequester> {
    // 父 run 缺失 / 空串（flow_graph planner_run_id 缺省落空串）→ 主 agent
    if !parent_run_id.is_some_and(|p| !p.is_empty()) {
        return None;
    }
    Some(ApprovalRequester {
        run_id: run_id.to_string(),
        // 任务类型由 spawner 注入面补齐（T-D-13），此处缺省 None
        task_type: None,
        reason,
    })
}

/// 申请理由在工具入参里的保留键（提示词协议层：子代理「需要更高权限时
/// 说明理由（需要什么、做什么、影响什么）」经本键随工具调用携带；执行器
/// 提取后原样透传，不做语义解析）
pub const APPROVAL_REASON_ARG_KEY: &str = "approval_reason";

/// 从工具入参提取申请理由（缺键 / 非字符串 → None，不报错）
pub fn approval_reason_from_args(args: &Value) -> Option<String> {
    args.get(APPROVAL_REASON_ARG_KEY)
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// 子代理申请被主 agent 拒绝的错误文案（对齐 explore_quota「回报主 agent」
/// 先例，调研 §2.6）：含「主 agent 拒绝」与「回报主 agent」双向指引。
pub fn relay_denied_message(reason: &str) -> String {
    format!(
        "权限申请被主 agent 拒绝：{reason}。如需继续，请把诉求与替代方案\
         以消息形式回报主 agent（说明为什么需要该权限、将执行什么操作、\
         影响范围），由主 agent 重新裁决或调整任务后重试。"
    )
}

/// 仲裁者 wire 值（广播载荷 metadata.arbiter，前端可观测裁决面）
pub const ARBITER_WIRE_MAIN_AGENT: &str = "main-agent";
/// 仲裁者 wire 值（用户裁决面；主 agent run 现状缺省不标注）
pub const ARBITER_WIRE_USER: &str = "user";

/// 仲裁者 → 广播载荷 metadata（T-D-14 路由分支的可观测落点）：
/// 子代理来源路由给主 agent → `{"arbiter": "main-agent"}`；用户裁决面
/// → None（主 agent run 现状载荷不变，向后兼容字节一致）。
pub fn arbiter_metadata(arbiter: Arbiter) -> Option<Value> {
    match arbiter {
        Arbiter::MainAgent => Some(serde_json::json!({ "arbiter": ARBITER_WIRE_MAIN_AGENT })),
        Arbiter::User => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 来源分类 ──

    /// 父 run 缺失 → 主 agent（无父 run 兜底 User 的前置分类）
    #[test]
    fn classify_no_parent_is_main_agent() {
        assert_eq!(
            classify_source("run-main", None),
            ApprovalSource::MainAgent
        );
        // 空串父 run（flow_graph planner_run_id 缺省）同样兜底主 agent
        assert_eq!(
            classify_source("run-x", Some("")),
            ApprovalSource::MainAgent
        );
    }

    /// 父 run 存在 → 子代理（携带本 run id 与父 run id）
    #[test]
    fn classify_with_parent_is_subagent() {
        assert_eq!(
            classify_source("run-sub-1", Some("run-main")),
            ApprovalSource::Subagent {
                run_id: "run-sub-1".into(),
                parent_run_id: "run-main".into(),
            }
        );
    }

    // ── 路由主映射 ──

    /// MainAgent → User（现状不变，既有 UI 审批流程全绿）
    #[test]
    fn route_main_agent_to_user() {
        assert_eq!(
            route_approval(&ApprovalSource::MainAgent),
            Arbiter::User
        );
    }

    /// Subagent → MainAgent（新默认）
    #[test]
    fn route_subagent_to_main_agent() {
        let source = ApprovalSource::Subagent {
            run_id: "run-sub-1".into(),
            parent_run_id: "run-main".into(),
        };
        assert_eq!(route_approval(&source), Arbiter::MainAgent);
    }

    /// 子代理 run 无父 run（数据异常）→ 兜底 User，不静默路由给主 agent
    #[test]
    fn orphan_subagent_falls_back_to_user() {
        // 分类层：空父 run 已折叠为主 agent → 用户兜底
        let orphan = classify_source("run-orphan", None);
        assert_eq!(orphan, ApprovalSource::MainAgent);
        assert_eq!(route_approval(&orphan), Arbiter::User);
    }

    // ── 死锁防护路由 ──

    /// 裁决者（主 agent）正在 wait 该子代理 → 转用户；未检测 → 主 agent
    #[test]
    fn guarded_route_deflects_when_arbiter_waiting() {
        let source = ApprovalSource::Subagent {
            run_id: "run-sub-1".into(),
            parent_run_id: "run-main".into(),
        };
        assert_eq!(
            route_approval_guarded(&source, true),
            Arbiter::User,
            "主 agent 正在 wait 该子代理 → 转用户打破 120s 空等"
        );
        assert_eq!(
            route_approval_guarded(&source, false),
            Arbiter::MainAgent,
            "未检测到 wait → 保持主 agent 裁决"
        );
        // 主 agent 来源恒用户（防护不改变现状面）
        assert_eq!(
            route_approval_guarded(&ApprovalSource::MainAgent, true),
            Arbiter::User
        );
    }

    // ── 请求方构造 ──

    /// 子代理 run（有父 run）→ Some，run_id = 子代理 run id + 理由透传
    #[test]
    fn requester_built_for_subagent_context() {
        let requester = requester_from_context(
            "run-sub-1",
            Some("run-main"),
            Some("需要写入报告目录".into()),
        )
        .expect("有父 run 必构造请求方");
        assert_eq!(requester.run_id, "run-sub-1");
        assert_eq!(
            requester.reason.as_deref(),
            Some("需要写入报告目录")
        );
        // task_type 注入面缺省 None（T-D-13 spawner 补齐）
        assert_eq!(requester.task_type, None);
    }

    /// 主 agent run（无父 run / 空父 run）→ None（现状：裁决者 = 用户）
    #[test]
    fn requester_none_for_main_agent_context() {
        assert_eq!(
            requester_from_context("run-main", None, None),
            None
        );
        assert_eq!(
            requester_from_context("run-main", Some(""), None),
            None
        );
    }

    // ── 理由提取 ──

    /// 保留键提取：字符串 → Some；缺键 / 非字符串 → None（不报错）
    #[test]
    fn reason_extraction_from_args() {
        let args = serde_json::json!({
            "command": "git push",
            APPROVAL_REASON_ARG_KEY: "需要推送分支到远端".to_string(),
        });
        assert_eq!(
            approval_reason_from_args(&args).as_deref(),
            Some("需要推送分支到远端")
        );
        assert_eq!(approval_reason_from_args(&serde_json::json!({})), None);
        assert_eq!(approval_reason_from_args(&serde_json::json!({ APPROVAL_REASON_ARG_KEY: 42 })), None);
        // 保留键不影响普通工具参数读取
        assert_eq!(args["command"], "git push");
    }

    // ── 拒绝文案 ──

    /// 拒绝文案含「主 agent 拒绝」与「回报主 agent」双向指引（对齐
    /// explore_quota「回报主 agent」先例的断言面）
    #[test]
    fn relay_denied_message_carries_guidance() {
        let message = relay_denied_message("写入范围超出默认集");
        assert!(message.contains("主 agent 拒绝"));
        assert!(message.contains("回报主 agent"));
        assert!(message.contains("写入范围超出默认集"));
        assert!(message.contains("替代方案"));
        // 理由参数化：不同理由仅差异段不同，结构固定
        let other = relay_denied_message("x");
        assert!(other.contains("主 agent 拒绝：x。"));
        assert!(message.contains("主 agent 拒绝：写入范围超出默认集。"));
    }

    // ── 仲裁者 wire ──

    /// 主 agent 裁决面 → metadata.arbiter=main-agent（前端可观测）；
    /// 用户裁决面 → None（主 agent run 现状载荷字节不变）
    #[test]
    fn arbiter_metadata_observable_only_for_main_agent() {
        assert_eq!(
            arbiter_metadata(Arbiter::MainAgent),
            Some(serde_json::json!({ "arbiter": "main-agent" }))
        );
        assert_eq!(arbiter_metadata(Arbiter::User), None);
        assert_eq!(ARBITER_WIRE_MAIN_AGENT, "main-agent");
        assert_eq!(ARBITER_WIRE_USER, "user");
    }
}
