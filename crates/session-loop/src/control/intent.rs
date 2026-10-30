//! 控制意图 wire 结构（自 control.rs 拆出，纯体积拆分，零逻辑改动）
//!
//! [ControlIntent] 为控制总线队列中的单条意图（对齐 TS RunControlIntent），
//! [ControlIntentInput] 为 `request()` 入参（id / createdAt / level 可由总线补齐）。

use conex_types::message::AgentMessage;
use serde::{Deserialize, Serialize};

use super::{ControlKind, ControlLevel};

/// 控制总线队列中的单条控制意图（对齐 TS RunControlIntent）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ControlIntent {
    /// 稳定 id，可观测 / 可测
    pub id: String,
    pub kind: ControlKind,
    /// L0-L3 代号
    pub level: ControlLevel,
    /// 入队时间（ms epoch）
    pub created_at: u64,
    /// soft_inject / steer / follow_up 附带消息
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<AgentMessage>,
    /// 人类可读原因
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// 来源（ui / hook / policy / system）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// request() 入参：id / createdAt / level 可由总线补齐
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlIntentInput {
    pub kind: ControlKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<AgentMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    /// 省略时按 kind 推导 level
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<ControlLevel>,
}

impl ControlIntentInput {
    /// 最简入队入口（kind + 可选消息）
    pub fn new(kind: ControlKind) -> Self {
        Self {
            kind,
            message: None,
            reason: None,
            source: None,
            id: None,
            created_at: None,
            level: None,
        }
    }
}
