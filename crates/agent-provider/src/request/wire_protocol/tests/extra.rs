//! `request/wire_protocol/tests.rs` 尾部测试旁挂（行数门禁拆分；测试名、断言与逻辑零改动）。
//!
//! 由模块根 `request/wire_protocol/tests.rs` 经 `mod extra;` 接入
//! （子模块路径 `request/wire_protocol/tests/extra.rs`）。
//! 承载：`WireProtocol::resolve_endpoint_url` 方法级断言。

use crate::request::wire_protocol::WireProtocol;

#[test]
fn test_wire_protocol_resolve_endpoint_url_method() {
    assert_eq!(
        WireProtocol::Chat.resolve_endpoint_url("https://api.openai.com/v1"),
        "https://api.openai.com/v1/chat/completions"
    );
    assert_eq!(
        WireProtocol::Responses.resolve_endpoint_url("https://api.openai.com/v1"),
        "https://api.openai.com/v1/responses"
    );
    assert_eq!(
        WireProtocol::Anthropic.resolve_endpoint_url("https://api.anthropic.com"),
        "https://api.anthropic.com/v1/messages"
    );
    // 测试别名常量的调用
    assert_eq!(
        WireProtocol::OpenAiChat.resolve_endpoint_url("https://api.deepseek.com"),
        "https://api.deepseek.com/v1/chat/completions"
    );
    assert_eq!(
        WireProtocol::OpenAiResponses.resolve_endpoint_url("https://api.openai.com"),
        "https://api.openai.com/v1/responses"
    );
    assert_eq!(
        WireProtocol::AnthropicMessages.resolve_endpoint_url("https://api.anthropic.com/v1/"),
        "https://api.anthropic.com/v1/messages"
    );
}
