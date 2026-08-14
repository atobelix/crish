//! B2.10 系统消息被拒 → user-prefix 重写重试测试（05 §5.2 transport::system_role）
//!
//! 服务端拒绝 system role（400 错误体提示不支持）→ 用 request/messages.rs 的
//! to_chat_messages 以 user-prefix 模式重写后重试成功。
//! 语义对齐 provider-openai-compatible.test.ts:593-1135（02 §六.11）。

mod common;

use agent_provider::consume::{consume, ConsumeStopReason};
use agent_provider::error::{classify_provider_error, ProviderError};
use agent_provider::parse::chat::ChatCompletionsParser;
use agent_provider::request::messages::{
    system_prompt_as_user_prefix, to_chat_messages, ChatContent, ChatMessage, ReasoningContentMode,
};
use common::{MockResponse, MockServer};
use conex_types::message::{AgentMessage, AgentMessageBlock, AgentMessageRole};
use conex_types::tool::SystemPromptWireMode;
use serde_json::json;

/// 便捷构造一条纯文本用户消息
fn user_message(text: &str) -> AgentMessage {
    AgentMessage {
        id: "m-1".to_string(),
        role: AgentMessageRole::User,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: text.to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    }
}

/// 把 wire 消息序列化为请求体
fn request_body(messages: &[ChatMessage]) -> serde_json::Value {
    json!({
        "model": "test-model",
        "messages": messages.iter().map(ChatMessage::to_value).collect::<Vec<_>>(),
    })
}

/// 服务端拒绝 system role（400）→ user-prefix 重写重试成功
#[tokio::test(flavor = "multi_thread")]
async fn system_role_rejected_then_user_prefix_rewrite_retries() {
    // 服务端脚本：请求体含 system role → 400 拒绝；否则 → 成功 SSE
    let server = MockServer::start(|request| {
        if request.body_contains("\"role\":\"system\"") {
            MockResponse::Plain {
                status: 400,
                headers: Vec::new(),
                body: "{\"error\":{\"message\":\"messages with role 'system' are not \
                       supported in this endpoint. Please rewrite as a user-prefix \
                       message.\"}}"
                    .to_string(),
            }
        } else {
            MockResponse::Sse {
                frames: common::chat_ok_frames("好的，我改用前缀模式"),
                interrupt_after: None,
            }
        }
    })
    .await;

    let system_prompt = "你是连接助手";
    let messages = vec![user_message("你好")];

    // 第一步：native system role 请求被服务端拒绝
    let native = to_chat_messages(
        Some(system_prompt),
        &messages,
        ReasoningContentMode::Omit,
        SystemPromptWireMode::NativeSystemRole,
    );
    assert_eq!(
        native[0].role, "system",
        "native 模式应产出 system role 消息"
    );
    let (status, body, _) =
        common::fetch_plain(server.addr, "/v1/chat/completions", request_body(&native)).await;
    assert_eq!(status, 400, "服务端应拒绝 system role");
    let classified = classify_provider_error(Some(status), Some(&body), None, None);
    assert!(
        matches!(classified, ProviderError::InvalidRequest { .. }),
        "system role 拒绝应按非法请求分类，得到 {classified:?}"
    );

    // 第二步：user-prefix 重写（02 §六.11：role 改 user + 前缀文案）
    let rewritten = to_chat_messages(
        Some(system_prompt),
        &messages,
        ReasoningContentMode::Omit,
        SystemPromptWireMode::UserPrefix,
    );
    assert!(
        rewritten.iter().all(|message| message.role != "system"),
        "重写后不应再有任何 system role 消息"
    );
    assert_eq!(
        rewritten[0].content,
        Some(ChatContent::Text(system_prompt_as_user_prefix(
            system_prompt
        )))
    );

    // 重写后的请求重试成功：transport → parse → consume
    let output = common::fetch_sse(
        server.addr,
        "/v1/chat/completions",
        request_body(&rewritten),
    )
    .await;
    let mut parser = ChatCompletionsParser::new();
    let mut events = Vec::new();
    for frame in &output.frames {
        events.extend(parser.push_frame(frame).expect("帧处理"));
    }
    events.extend(parser.finish().expect("流结束"));
    let result = consume(events, false);
    assert!(result.response.is_message());
    assert_eq!(result.response.text(), "好的，我改用前缀模式");
    assert_eq!(result.stop_reason(), Some(ConsumeStopReason::Stop));

    // 服务端记录：第一次含 system role，第二次已重写为 user-prefix
    let requests = server.wait_for_requests(2).await;
    assert_eq!(requests.len(), 2);
    assert!(requests[0].body.contains("\"role\":\"system\""));
    assert!(!requests[1].body.contains("\"role\":\"system\""));
    assert!(requests[1]
        .body
        .contains("System instructions for this run"));
}

/// 消息内嵌的 system 消息同样走 user-prefix 重写路径
#[tokio::test(flavor = "multi_thread")]
async fn in_message_system_role_is_rewritten_too() {
    let system_message = AgentMessage {
        id: "m-0".to_string(),
        role: AgentMessageRole::System,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        blocks: vec![AgentMessageBlock::Text {
            text: "消息内系统指令".to_string(),
        }],
        metadata: None,
        client_message_id: None,
        content: None,
    };
    let rewritten = to_chat_messages(
        None,
        &[system_message, user_message("hi")],
        ReasoningContentMode::Omit,
        SystemPromptWireMode::UserPrefix,
    );
    assert_eq!(rewritten.len(), 2);
    assert_eq!(rewritten[0].role, "user", "消息内 system 也要改写为 user");
    assert_eq!(
        rewritten[0].content,
        Some(ChatContent::Text(
            "System instructions for this run:\n\n消息内系统指令".to_string()
        ))
    );
    assert_eq!(rewritten[1].role, "user");
}
