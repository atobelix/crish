//! G5-compat 消息序列化消费辅助（SR-06e · 拆分 · ≠ EL；R2 T2.2/T2.3）
//!
//! 从 messages.rs 拆出的「[WireCompat] 上下文载体 + 模型级判定辅助」子模块：
//! - 序列化层（messages.rs / to_chat_messages_with_compat）按 [WireCompat] 驱动
//!   reasoning_content 强制键与 developer role；本模块承载判定入参载体与纯判定。
//! - 对齐 R1 T1.7 纯函数面（compat.rs 的 [resolve_developer_role] /
//!   [empty_content_wire_value]），保持「判定是纯函数消费，不是领域层逻辑」——
//!   不向 [AgentMessage] / 会话状态注入任何合成内容（INV-07 领域真实性）。
//!
//! 2026 统一重构（TU-03）：
//! - 彻底删除 `is_deepseek` 中的 `url.contains("deepseek")` 字符串盲猜；
//! - 改为精确根据 `vendor == "deepseek"` 或配置中的 `compat.thinking_format == "deepseek"` 判定。
//!
//! SR-06e · 拆分 · ≠ EL：独立新子模块（[messages.rs] 经 `#[path]` 接线）。

use conex_types::message::AgentMessage;

use super::messages_content::thought_content;

/// wire 消息序列化 compat 上下文（G5-a/G5-b · T2.2/T2.3；R2 消息序列化消费面）
///
/// 承载模型级兼容判定入参：vendor/thinking_format 用于判定 DeepSeek
/// （reasoning_content 模型级强制键），supports_developer_role 用于判定 developer role。
#[derive(Debug, Clone, Copy, Default)]
pub struct WireCompat<'a> {
    /// 厂商名（DeepSeek 判定入参；`None` → 非 DeepSeek 轨）
    pub vendor: Option<&'a str>,
    /// 思考方言格式配置（如 "deepseek"）
    pub thinking_format: Option<&'a str>,
    /// 显式 developer role 支持（yaml `compat.supportsDeveloperRole`，缺省 false）
    pub supports_developer_role: bool,
}

impl<'a> WireCompat<'a> {
    /// 从供应商及 CompatSpec 构造 WireCompat
    pub fn from_compat(
        vendor: Option<&'a str>,
        compat: Option<&'a crate::models::catalog_types::CompatSpec>,
    ) -> Self {
        let thinking_format = compat.and_then(|c| c.thinking_format).map(|tf| match tf {
            crate::models::catalog_types::ThinkingFormat::OpenAi => "openai",
            crate::models::catalog_types::ThinkingFormat::DeepSeek => "deepseek",
            crate::models::catalog_types::ThinkingFormat::Qwen => "qwen",
            crate::models::catalog_types::ThinkingFormat::Zai => "zai",
            crate::models::catalog_types::ThinkingFormat::Anthropic => "anthropic",
            crate::models::catalog_types::ThinkingFormat::Gemini => "gemini",
        });
        Self {
            vendor,
            thinking_format,
            supports_developer_role: compat
                .and_then(|c| c.supports_developer_role)
                .unwrap_or(false),
        }
    }

    /// DeepSeek 厂商推断：精确由 vendor == "deepseek" 或 compat.thinking_format == "deepseek" 决定。
    /// 彻底废除基于 URL 子串的模糊盲猜（url.contains("deepseek") 已被彻底根除）。
    pub fn is_deepseek(&self) -> bool {
        let vendor = self.vendor.unwrap_or("").trim();
        let format = self.thinking_format.unwrap_or("").trim();
        vendor.eq_ignore_ascii_case("deepseek") || format.eq_ignore_ascii_case("deepseek")
    }
}

/// system 消息 wire 角色（G5-a · T2.3）：yaml 显式声明 developer role →
/// `"developer"`，否则恒 `"system"`。user-prefix 分支由调用方恒置 `"user"` 不参与本判定。
pub fn resolve_system_role(compat: &WireCompat<'_>) -> &'static str {
    if compat.supports_developer_role {
        "developer"
    } else {
        "system"
    }
}

/// DeepSeek reasoning_content 模型级强制键取值（G5-b · T2.2）
///
/// DeepSeek 厂商 + 带 tool_calls 的回合 → 必带键：有思考回传思考、无思考空串
/// 兜底（对齐 DSH serialize.ts:99 的 tool-call 回合必带 passback 语义；直接读
/// [thought_content]，不经 [ReasoningContentMode]——模型级强制不以 Omit 的省略
/// 语义丢弃既有思考）。非 DeepSeek 或非 tool-call 回合 → 返回 `None`，由调用方
/// 沿用既有 mode 语义（不改写）。
pub fn deepseek_tool_call_reasoning(
    compat: &WireCompat<'_>,
    has_tool_call: bool,
    message: &AgentMessage,
) -> Option<String> {
    if !(compat.is_deepseek() && has_tool_call) {
        return None;
    }
    let thought = thought_content(message);
    if thought.is_empty() {
        Some(String::new())
    } else {
        Some(thought)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_deepseek_exact_vendor_and_format() {
        // vendor == "deepseek" (case insensitive)
        assert!(WireCompat {
            vendor: Some("deepseek"),
            ..WireCompat::default()
        }
        .is_deepseek());

        assert!(WireCompat {
            vendor: Some("DeepSeek"),
            ..WireCompat::default()
        }
        .is_deepseek());

        // thinking_format == "deepseek"
        assert!(WireCompat {
            thinking_format: Some("deepseek"),
            ..WireCompat::default()
        }
        .is_deepseek());

        assert!(WireCompat {
            thinking_format: Some("DEEPSEEK"),
            ..WireCompat::default()
        }
        .is_deepseek());

        // Default WireCompat must not be deepseek
        assert!(!WireCompat::default().is_deepseek());

        // Non-deepseek vendor
        assert!(!WireCompat {
            vendor: Some("openai"),
            ..WireCompat::default()
        }
        .is_deepseek());
    }

    #[test]
    fn test_deepseek_tool_call_reasoning_passback() {
        use conex_types::message::AgentMessageBlock;

        let compat_ds = WireCompat {
            vendor: Some("deepseek"),
            ..WireCompat::default()
        };
        let compat_non_ds = WireCompat {
            vendor: Some("openai"),
            ..WireCompat::default()
        };

        let msg_with_thought = AgentMessage {
            id: "msg1".into(),
            role: conex_types::message::AgentMessageRole::Assistant,
            created_at: "2026-09-07T00:00:00Z".into(),
            blocks: vec![AgentMessageBlock::Thought {
                text: "thinking...".into(),
                redacted: None,
            }],
            metadata: None,
            client_message_id: None,
            content: None,
        };

        let msg_empty = AgentMessage {
            id: "msg2".into(),
            role: conex_types::message::AgentMessageRole::Assistant,
            created_at: "2026-09-07T00:00:00Z".into(),
            blocks: vec![],
            metadata: None,
            client_message_id: None,
            content: None,
        };

        // DeepSeek with tool call and thought -> Some("thinking...")
        assert_eq!(
            deepseek_tool_call_reasoning(&compat_ds, true, &msg_with_thought),
            Some("thinking...".to_string())
        );

        // DeepSeek with tool call without thought -> Some("") fallback
        assert_eq!(
            deepseek_tool_call_reasoning(&compat_ds, true, &msg_empty),
            Some("".to_string())
        );

        // DeepSeek without tool call -> None (does not force)
        assert_eq!(
            deepseek_tool_call_reasoning(&compat_ds, false, &msg_with_thought),
            None
        );

        // Non-DeepSeek with tool call -> None
        assert_eq!(
            deepseek_tool_call_reasoning(&compat_non_ds, true, &msg_with_thought),
            None
        );
    }
}
