//! nudge 文本生成与注入消息构建（决策 9：nudge 未接线半成品通道已删除）
//!
//! ## E2 扩展点 A 承载登记（统一输入流收敛 · 扩展门面详案 §1②）
//!
//! **已登记为 A（注入时机）承载面的纠偏文本侧**：A 的承载缝 =
//! `AgentInputQueue` 三环（crates/session-loop/src/input.rs:163，
//! Force/Steer/FollowUp）+ 编排层 `PendingMessageQueue`
//! （crates/orchestrator/src/steering_queue.rs:111）——**评审 04 决策 9
//! 对齐**：`PendingNudgeChannel` 已由 I1 删除（nudge 通道归零），A 承载
//! 缝不再引用它。本模块只承载「当前 run 纠偏注入」的文本生成与消息
//! 构建（`runtime_steering_text` / `build_steering_message`，经
//! `SteeringCoordinator::apply` 消费）；跨 run「下一条用户消息」统一走
//! `PendingMessageQueue`。动态状态注入 `context-state` 节点（模型名/
//! 权限/思考模式）由 I1/T1 承载，E2 仅登记不超前实现。
//!
//! 裁决 D8/D9（01 第四章）：**当前 run 的纠偏注入**复用本模块的文本生成器；
//! 跨 run 的「下一条用户消息」规范载体统一为 orchestrator
//! `PendingMessageQueue`（见详案 I1-α① 队列归一），nudge 独立半成品通道
//! （未接线结构与直通入口）已删除（决策点 9——生产零接线，仅测试引用）。
//!
//! 本模块保留（当前 run 纠偏正用，[steering::SteeringCoordinator::apply] 消费）：
//! - [runtime_steering_text]：纠偏提示语生成（中英双语，对齐 TS
//!   runtime-helpers.ts 的 runtimeSteeringText）；
//! - [build_steering_message]：steering 注入消息构建（system 角色，
//!   metadata.kind 取枚举 [AgentMessageMetadataKind::Steering] canonical
//!   wire（T1a 定案；历史旧值已随 I1-α④ 枚举化收编，对齐 01 §3.5））；
//! - [diagnostic_message]：诊断事件附带消息（emit-diagnostic 用）。

use std::sync::atomic::{AtomicU64, Ordering};

use conex_types::message::{
    AgentMessage, AgentMessageBlock, AgentMessageMetadataKind, AgentMessageRole,
};

use crate::steering::{metadata_kind_wire, now_iso_utc, unix_millis, SteeringReason};

/// 消息 id 计数器（保证同毫秒内多次注入 id 唯一）
static MESSAGE_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

fn new_message_id(prefix: &str) -> String {
    let n = MESSAGE_ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{n}", unix_millis())
}

/// 纠偏提示语（中英双语，对齐 TS runtimeSteeringText）
///
/// - `tool-errors`：连续工具失败——不要重复同一次调用，调整参数或策略；
/// - `tool-loop`：重复调用——停止循环，总结已知信息，换策略或求助；
/// - `empty-response`：空响应——不要静默停止，调用下一步工具或一句话说明阻碍。
pub fn runtime_steering_text(reason: SteeringReason) -> String {
    match reason {
        SteeringReason::ToolErrors => [
            "运行期纠偏：最近的工具调用连续失败。",
            "不要重复同一次调用。请简要定位失败原因，调整参数或策略，",
            "仅在下一次动作确实不同时继续。",
            "若现有工具无法解决阻碍，请停止并说明阻碍。",
            "",
            "Runtime steering: recent tool calls failed repeatedly.",
            "Do not repeat the same call. Diagnose the failure briefly, change the",
            "arguments or strategy, and continue only with a materially different",
            "next action. If the blocker cannot be resolved with the available",
            "tools, stop and explain the blocker.",
        ]
        .join("\n"),
        SteeringReason::EmptyResponse => [
            "运行期纠偏：上一轮助手没有产出可见文字，也没有调用工具。",
            "不要静默停止。请调用下一步所需的工具，或用一句简洁的话说明阻碍。",
            "若用户要求创建或检查文件，请先使用可用的文件系统工具再作答。",
            "",
            "Runtime steering: the previous assistant turn produced no visible",
            "text and no tool call. Do not stop silently. Either call the next",
            "required tool or explain the blocker in one concise message. If the",
            "user requested file creation or inspection, use the available",
            "filesystem tools before answering.",
        ]
        .join("\n"),
        SteeringReason::ToolLoop => [
            "运行期纠偏：同一个工具调用似乎在重复。",
            "请停止循环，总结已知信息，选择不同的策略或请求用户指引，",
            "而不是再次发出同一次调用。",
            "",
            "Runtime steering: the same tool call appears to be repeating.",
            "Stop the loop, summarize what is already known, and choose a",
            "different strategy or ask for user guidance instead of issuing the",
            "same call again.",
        ]
        .join("\n"),
    }
}

/// 构建 steering 注入消息（system 角色，01 §3.5）
///
/// metadata.kind 取枚举 [AgentMessageMetadataKind::Steering] canonical wire
/// （T1a 定案；历史旧值已随详案 I1-α④ 枚举化收编，统一后无行为影响）；
/// `steeringCount` 为注入**后**的计数（对齐 TS createTextMessage 传
/// `context.steeringCount + 1`）。
pub fn build_steering_message(reason: SteeringReason, steering_count: usize) -> AgentMessage {
    let text = runtime_steering_text(reason);
    AgentMessage {
        id: new_message_id(metadata_kind_wire(AgentMessageMetadataKind::Steering).as_str()),
        role: AgentMessageRole::System,
        created_at: now_iso_utc(),
        blocks: vec![AgentMessageBlock::Text { text }],
        metadata: Some(serde_json::json!({
            "kind": AgentMessageMetadataKind::Steering,
            "reason": reason.as_str(),
            "steeringCount": steering_count,
            "thinking_budget": 0,
            "thinkingBudget": 0,
        })),
        client_message_id: None,
        content: None,
    }
}

/// 构建诊断事件附带消息（emit-diagnostic 用，不修改对话）
///
/// metadata.kind 取枚举 [AgentMessageMetadataKind::Diagnostic] canonical wire。
pub(crate) fn diagnostic_message(text: &str) -> AgentMessage {
    AgentMessage {
        id: new_message_id(metadata_kind_wire(AgentMessageMetadataKind::Diagnostic).as_str()),
        role: AgentMessageRole::System,
        created_at: now_iso_utc(),
        blocks: vec![AgentMessageBlock::Text {
            text: text.to_string(),
        }],
        metadata: Some(serde_json::json!({ "kind": AgentMessageMetadataKind::Diagnostic })),
        client_message_id: None,
        content: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steering_text_distinct_for_each_reason() {
        let texts: std::collections::BTreeSet<String> = [
            SteeringReason::ToolErrors,
            SteeringReason::ToolLoop,
            SteeringReason::EmptyResponse,
        ]
        .iter()
        .map(|r| runtime_steering_text(*r))
        .collect();
        assert_eq!(texts.len(), 3, "三种原因提示语各不相同");
        for text in &texts {
            assert!(!text.is_empty());
            assert!(text.contains('中') || text.contains("纠偏"), "含中文提示");
            assert!(
                text.contains("Runtime steering"),
                "含英文对照（对齐 TS 文案）"
            );
        }
    }

    #[test]
    fn steering_message_shape() {
        let message = build_steering_message(SteeringReason::ToolLoop, 2);
        assert_eq!(message.role, AgentMessageRole::System);
        assert!(message.id.starts_with("steering-"));
        assert!(!message.text().is_empty());
        let metadata = message.metadata.as_ref().expect("注入消息须带元数据");
        assert_eq!(
            metadata.get("kind").and_then(|k| k.as_str()),
            Some(metadata_kind_wire(AgentMessageMetadataKind::Steering).as_str()),
            "kind 走 T1a 枚举 canonical wire（I1-α④ 已收编 runtime-steering）"
        );
        assert_eq!(
            metadata.get("reason").and_then(|r| r.as_str()),
            Some("tool-loop")
        );
        assert_eq!(
            metadata.get("steeringCount").and_then(|c| c.as_u64()),
            Some(2)
        );
    }
}
