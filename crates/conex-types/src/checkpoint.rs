//! C1 checkpoint 协议层共享类型（M5A 采集端；04-Agent功能需求设计.md §2 C1）
//!
//! 多 Agent 调度能力 C1「checkpoint 优先恢复」的协议载体：
//! 子代理 / 主代理在对话中周期性输出一行结构化检查点
//! （`CHECKPOINT: {json}`，jcode JCODE_CHECKPOINT 借鉴，02 方案 Top 5），
//! 引擎在安全点（safe_point.rs）采集该行标记，把检查点写入会话树叶子
//! 节点 payload 的保留键（[CHECKPOINT_PAYLOAD_KEY]）。
//!
//! 本模块为跨 crate 共享的协议层类型：session-loop（安全点采集）与
//! orchestrator（会话树叶子 payload 读写）复用同一载荷形状与解析语义；
//! 载荷形状 = C1 规格字段（目标 / 已完成步骤 / 文件清单 / 下一步）+
//! 摘要与时间戳（M5 任务卡：含目标/摘要/时间戳）。

use serde::{Deserialize, Serialize};
use std::fmt;

/// 行标记主前缀（任务约定：`CHECKPOINT: {json}`，冒号后为 JSON 载荷）
pub const CHECKPOINT_MARKER: &str = "CHECKPOINT:";
/// 行标记别名前缀（02 方案 Top 5 命名 `CONEX_CHECKPOINT {json}`，兼容识别）
pub const CONEX_CHECKPOINT_MARKER: &str = "CONEX_CHECKPOINT";
/// 叶子节点 payload 中的检查点保留键（写入 `checkpoint` 字段，不触碰
/// payload 其它字段；会话树主写权归 C6，本键为 M5 最小落库面）
pub const CHECKPOINT_PAYLOAD_KEY: &str = "checkpoint";

/// 恢复检测信号（引擎检测：run 初始化时叶子有有效检查点 → 事件/元数据标记）
pub const CHECKPOINT_PRESENT_SIGNAL: &str = "checkpoint-present";
/// 恢复检测信号（叶子检查点损坏 → 降级普通会话，不启用优先恢复）
pub const CHECKPOINT_CORRUPT_SIGNAL: &str = "checkpoint-corrupt";

/// 检查点载荷（行标记 JSON 载荷与叶子 payload 共用形状，serde camelCase）
///
/// 必填字段：目标 / 摘要；可选字段：时间戳（采集端缺省补当前时间）、
/// 已完成步骤 / 文件清单 / 下一步（对齐 C1 规格与 M10 五字段模板的
/// 语义交集）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointPayload {
    /// 当前目标（一句话，恢复时「目标剩余部分」的锚点）
    pub target: String,
    /// 已完成进展摘要（恢复输入的核心，不重放检查点之前的历史）
    pub summary: String,
    /// 检查点声明时间（ISO8601，如 `2026-08-03T10:00:00.000Z`；
    /// 行标记未携带时由采集端补当前时间）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    /// 已完成步骤清单
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub completed: Vec<String>,
    /// 涉及文件清单
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<String>,
    /// 下一步清单
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub next: Vec<String>,
}

/// 检查点解析错误（损坏降级信号；fail-open 语义：解析失败不 panic、
/// 不抛未分类错误，由调用方降级普通会话并通知主 agent「检查点失效」）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointError {
    /// 错误类别（`checkpoint.parse_failed`）
    pub kind: String,
    /// 错误详情
    pub message: String,
}

impl CheckpointError {
    /// 构造检查点错误
    pub fn new(kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
        }
    }
}

impl fmt::Display for CheckpointError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for CheckpointError {}

/// 叶子检查点读取状态（引擎检测 / 恢复判定输入；三态语义）
#[derive(Debug, Clone, PartialEq)]
pub enum LeafCheckpointState {
    /// 无检查点（现状：不启用优先恢复，按既有路径续跑）
    Absent,
    /// 有效检查点（恢复时优先消费检查点摘要 + 目标剩余部分）
    Present(CheckpointPayload),
    /// 检查点损坏（payload 存在但解析失败 → 降级普通会话；
    /// message 供「检查点失效」通知使用）
    Corrupt(String),
}

impl LeafCheckpointState {
    /// 是否存在有效检查点
    pub fn is_present(&self) -> bool {
        matches!(self, Self::Present(_))
    }

    /// 引擎检测信号（有检查点 → 对应事件/元数据标记；无 → None 保持现状）
    pub fn signal(&self) -> Option<&'static str> {
        match self {
            Self::Present(_) => Some(CHECKPOINT_PRESENT_SIGNAL),
            Self::Corrupt(_) => Some(CHECKPOINT_CORRUPT_SIGNAL),
            Self::Absent => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> CheckpointPayload {
        CheckpointPayload {
            target: "实现检查点采集".into(),
            summary: "协议类型与行标记解析已落地".into(),
            timestamp: Some("2026-08-03T10:00:00.000Z".into()),
            completed: vec!["定义载荷形状".into()],
            files: vec!["crates/conex-types/src/checkpoint.rs".into()],
            next: vec!["接线恢复注入".into()],
        }
    }

    /// 载荷 serde 往返：camelCase 字段名 + 可选字段缺省（旧载荷兼容）
    #[test]
    fn payload_roundtrip_with_camel_case_fields() {
        let payload = sample();
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["target"], "实现检查点采集");
        assert_eq!(json["summary"], "协议类型与行标记解析已落地");
        assert_eq!(json["timestamp"], "2026-08-03T10:00:00.000Z");
        assert_eq!(json["completed"][0], "定义载荷形状");
        assert_eq!(json["files"][0], "crates/conex-types/src/checkpoint.rs");
        assert_eq!(json["next"][0], "接线恢复注入");

        let back: CheckpointPayload = serde_json::from_value(json).unwrap();
        assert_eq!(back, payload);
    }

    /// 缺省字段兼容：旧/精简标记行缺 timestamp/completed/files/next 可解析
    #[test]
    fn payload_accepts_minimal_shape() {
        let raw = r#"{"target":"目标","summary":"摘要"}"#;
        let payload: CheckpointPayload = serde_json::from_str(raw).unwrap();
        assert_eq!(payload.target, "目标");
        assert_eq!(payload.summary, "摘要");
        assert!(payload.timestamp.is_none());
        assert!(payload.completed.is_empty());
        assert!(payload.files.is_empty());
        assert!(payload.next.is_empty());
    }

    /// 叶子状态检测信号：Present → checkpoint-present、Corrupt →
    /// checkpoint-corrupt、Absent → None（无检查点保持现状）
    #[test]
    fn leaf_state_signals() {
        assert_eq!(
            LeafCheckpointState::Present(sample()).signal(),
            Some(CHECKPOINT_PRESENT_SIGNAL)
        );
        assert_eq!(
            LeafCheckpointState::Corrupt("解析失败".into()).signal(),
            Some(CHECKPOINT_CORRUPT_SIGNAL)
        );
        assert_eq!(LeafCheckpointState::Absent.signal(), None);
        assert!(LeafCheckpointState::Present(sample()).is_present());
        assert!(!LeafCheckpointState::Absent.is_present());
        assert!(!LeafCheckpointState::Corrupt("x".into()).is_present());
    }

    /// 解析错误形状：kind + message（对齐 RewindError / RestoreError 惯例）
    #[test]
    fn error_shape_and_display() {
        let err = CheckpointError::new("checkpoint.parse_failed", "载荷损坏");
        assert_eq!(err.kind, "checkpoint.parse_failed");
        assert_eq!(err.to_string(), "checkpoint.parse_failed: 载荷损坏");
    }
}
