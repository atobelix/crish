//! 出站端点类型。配置的读取和写入只由 model_store 承载。

use serde::{Deserialize, Serialize};

/// 端点类型（对齐壳 `normalize_provider_endpoint` 的合法值集合）。
///
/// 序列化为 kebab-case：`auto` / `responses` / `chat-completions`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Endpoint {
    /// 自动选择（当前实现恒退化为 chat-completions，见 02 §五 #1 裁决）。
    Auto,
    /// OpenAI Responses API。
    Responses,
    /// OpenAI 兼容 chat-completions API。
    /// 00 主方案 §3 D3：未显式指定端点时恒为 chat-completions。
    #[default]
    ChatCompletions,
}

impl Endpoint {
    /// 解析端点字符串，兼容壳的别名规范化（`chat`→chat-completions、`response`→responses、
    /// `_`/`/` 归一为 `-`、大小写不敏感）。
    pub fn parse(value: &str) -> Option<Self> {
        match value
            .trim()
            .to_ascii_lowercase()
            .replace(['_', '/'], "-")
            .as_str()
        {
            "auto" => Some(Self::Auto),
            "responses" | "response" => Some(Self::Responses),
            "chat-completions" | "chat" => Some(Self::ChatCompletions),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Responses => "responses",
            Self::ChatCompletions => "chat-completions",
        }
    }
}

impl<'de> Deserialize<'de> for Endpoint {
    /// 反序列化时做与 `parse` 相同的别名归一，非法值报解析错误。
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value)
            .ok_or_else(|| serde::de::Error::custom(format!("无效的端点类型：{value}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_alias_parsing() {
        assert_eq!(
            Endpoint::parse("chat-completions"),
            Some(Endpoint::ChatCompletions)
        );
        assert_eq!(Endpoint::parse("responses"), Some(Endpoint::Responses));
        assert_eq!(Endpoint::parse("unknown"), None);
    }
    #[test]
    fn endpoint_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_value(Endpoint::ChatCompletions).unwrap(),
            "chat-completions"
        );
        assert_eq!(
            serde_json::to_value(Endpoint::Responses).unwrap(),
            "responses"
        );
    }
}
