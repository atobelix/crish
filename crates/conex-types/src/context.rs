//! 上下文预算与会话级元数据域（P4 §3.3.2 / §3.7 / 阶段 5-1）
//!
//! `ContextBudget` 供 session-loop 预算层（T-33 钳制/预检）注入，
//! 缺省 `None` = 不启用钳制与预检压缩（向后兼容现状）；
//! `SessionContextMeta` 供 orchestrator 随会话记录持久化
//! （T-34 护栏跨重启恢复，restore.rs 重建护栏状态用）。

use serde::{Deserialize, Serialize};

/// 输出预算安全垫（对齐 pi simple-options.ts:12-19：window - estimate - 4096）
pub const CONTEXT_SAFETY_TOKENS: u32 = 4096;

/// 预算配置（引擎/会话级注入；缺省 `None` = 不启用钳制与预检压缩）
///
/// 字段与默认值对齐 P4 §3.3.2；`context_window` 数据源为 P3
/// 模型目录（`context_window_for`），P3 未接线前由前端 `context_window`
/// 参数兜底（§3.7 / A1 审计修正）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBudget {
    /// 模型上下文窗口（token）
    pub context_window: u32,
    /// 压缩保留余量（阈值 = window - reserve，对齐 pi 默认 16384）
    pub reserve_tokens: u32,
    /// 输出预算安全垫（默认 4096）
    pub safety_tokens: u32,
}

impl Default for ContextBudget {
    fn default() -> Self {
        Self {
            context_window: 64_000,
            reserve_tokens: 16_384,
            safety_tokens: CONTEXT_SAFETY_TOKENS,
        }
    }
}

/// 会话级上下文元数据（orchestrator 随会话记录持久化，restore 时恢复）
///
/// 护栏字段与 T-34 的持久化对齐（P4 阶段 5-1 / §3.4.6）：
/// `last_compaction_at` 为时间戳护栏（usage 源消息早于它则作废），
/// `last_compaction_generation` 为压缩代数（C13：压缩重置 P5 审计基线
/// generation +1），`compression_retries` 为溢出压缩重试计数（上限 1）。
/// 全部字段 `#[serde(default)]`，StateSnapshot schema 兼容扩展不缺省。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionContextMeta {
    /// 压缩边界（epoch ms；usage 源消息早于它则作废，§3.3.1 时间戳护栏）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_compaction_at: Option<i64>,
    /// 对应事件序列（审计锚点）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_compaction_sequence: Option<u64>,
    /// 压缩代数（压缩事件重置 P5 审计基线时 +1，C13）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_compaction_generation: Option<u64>,
    /// 溢出压缩重试计数（§3.5 上限 1；持久化供 restore 重建护栏状态）
    #[serde(default)]
    pub compression_retries: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_budget_default_values() {
        let budget = ContextBudget::default();
        assert_eq!(budget.context_window, 64_000);
        assert_eq!(budget.reserve_tokens, 16_384);
        assert_eq!(budget.safety_tokens, CONTEXT_SAFETY_TOKENS);
        assert_eq!(budget.safety_tokens, 4096);
    }

    #[test]
    fn context_budget_serializes_to_camel_case() {
        let budget = ContextBudget { context_window: 128_000, reserve_tokens: 20_000, safety_tokens: 4096 };
        let json = serde_json::to_value(budget).unwrap();
        assert_eq!(json["contextWindow"], 128_000);
        assert_eq!(json["reserveTokens"], 20_000);
        assert_eq!(json["safetyTokens"], 4096);
        assert!(json.get("context_window").is_none());
    }

    #[test]
    fn context_budget_roundtrip() {
        let budget = ContextBudget { context_window: 64_000, reserve_tokens: 16_384, safety_tokens: 4096 };
        let json = serde_json::to_string(&budget).unwrap();
        let back: ContextBudget = serde_json::from_str(&json).unwrap();
        assert_eq!(budget, back);
    }

    #[test]
    fn session_context_meta_defaults_to_absent_guards() {
        // 旧 schema 无该字段 → 全部缺省（StateSnapshot 兼容扩展）
        let raw = r#"{}"#;
        let meta: SessionContextMeta = serde_json::from_str(raw).unwrap();
        assert_eq!(meta.last_compaction_at, None);
        assert_eq!(meta.last_compaction_sequence, None);
        assert_eq!(meta.last_compaction_generation, None);
        assert_eq!(meta.compression_retries, 0);
    }

    #[test]
    fn session_context_meta_serializes_to_camel_case() {
        let meta = SessionContextMeta {
            last_compaction_at: Some(1_700_000_000_000),
            last_compaction_sequence: Some(42),
            last_compaction_generation: Some(3),
            compression_retries: 1,
        };
        let json = serde_json::to_value(&meta).unwrap();
        assert_eq!(json["lastCompactionAt"], 1_700_000_000_000i64);
        assert_eq!(json["lastCompactionSequence"], 42);
        assert_eq!(json["lastCompactionGeneration"], 3);
        assert_eq!(json["compressionRetries"], 1);
        assert!(json.get("last_compaction_at").is_none());
    }

    #[test]
    fn session_context_meta_roundtrip() {
        let meta = SessionContextMeta {
            last_compaction_at: Some(1_700_000_000_000),
            last_compaction_sequence: Some(7),
            last_compaction_generation: Some(2),
            compression_retries: 0,
        };
        let json = serde_json::to_string(&meta).unwrap();
        let back: SessionContextMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(meta, back);
    }

    #[test]
    fn session_context_meta_skips_none_fields() {
        let meta = SessionContextMeta::default();
        let json = serde_json::to_value(&meta).unwrap();
        assert!(json.get("lastCompactionAt").is_none());
        assert!(json.get("lastCompactionSequence").is_none());
        assert!(json.get("lastCompactionGeneration").is_none());
        assert_eq!(json["compressionRetries"], 0);
    }
}
