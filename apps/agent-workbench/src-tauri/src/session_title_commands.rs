//! 会话短标题（b6）。首条助手回复完成后，用当前 provider 的 chat-completions
//! 生成不超过 12 个字的标题。
//!
//! 与 engine_channels 里的 ProviderSummarizer 同一套请求零件：
//! `provider_config` / `http_client` / `build_chat_completions_request_body` /
//! `chat_provider_url` / `summary_content_from_response` / `max_tokens_field` /
//! `user_message`。本命令本身是 async，不另开线程。无 tools、无缓存键，
//! 超时 15s，`max_tokens` 64。失败返回结构化 [`CoreError`]，由前端保留
//! 既有标题，不在这里重试。

use std::sync::Arc;
use std::time::Duration;

use agent_provider::request::{
    build_chat_completions_request_body, ChatCompletionsRequestOptions, RequestBuildContext,
};
use conex_types::tool::SystemPromptWireMode;

use conex_run::core_error::CoreError;
use conex_run::engine_channels::summary_content_from_response;
use conex_run::engine_provider::{
    chat_provider_url, max_tokens_field, user_message, EngineProviderConfig,
};
use conex_run::run::CoreRunState;

/// 标题正文上限（Unicode 标量值，不是字节）。
pub(crate) const SESSION_TITLE_MAX_CHARS: usize = 12;
/// 每侧送进提示词的原文上限，避免一次标题请求带上整段对话。
pub(crate) const SESSION_TITLE_INPUT_CAP: usize = 400;
const SESSION_TITLE_MAX_TOKENS: u64 = 64;
const SESSION_TITLE_HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// 模型生成的会话标题（camelCase wire 只有 `title`）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSessionTitleResult {
    pub title: String,
}

/// 生成会话短标题。`session_id` 只用于校验和日志，不写入提示词。
#[tauri::command]
pub(crate) async fn core_generate_session_title(
    state: tauri::State<'_, Arc<CoreRunState>>,
    session_id: String,
    user_text: String,
    assistant_text: String,
) -> Result<GenerateSessionTitleResult, CoreError> {
    generate_session_title_impl(&state, &session_id, &user_text, &assistant_text).await
}

pub(crate) async fn generate_session_title_impl(
    state: &Arc<CoreRunState>,
    session_id: &str,
    user_text: &str,
    assistant_text: &str,
) -> Result<GenerateSessionTitleResult, CoreError> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        return Err(CoreError::InvalidInput("sessionId 不能为空".to_string()));
    }
    if !session_title_has_input(user_text, assistant_text) {
        return Err(CoreError::InvalidInput(
            "缺少可用于生成标题的对话文本".to_string(),
        ));
    }
    let Some(config) = state.engine().provider_config() else {
        return Err(CoreError::InvalidInput(
            "LLM 标题不可用（请配置 provider 后重试）".to_string(),
        ));
    };
    tracing::debug!(
        target: "session_title",
        session_id,
        "请求模型生成会话标题"
    );
    let body = build_session_title_request_body(&config, user_text, assistant_text);
    let url = chat_provider_url(&config);
    let api_key = config.api_key.clone();
    let client = state.engine().http_client();
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .timeout(SESSION_TITLE_HTTP_TIMEOUT)
        .json(&body)
        .send()
        .await
        .map_err(|error| CoreError::Io(format!("会话标题请求失败：{error}")))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| CoreError::Io(format!("会话标题响应读取失败：{error}")))?;
    if !status.is_success() {
        let excerpt: String = text.chars().take(200).collect();
        return Err(CoreError::Io(format!("会话标题 HTTP {status}：{excerpt}")));
    }
    let content = summary_content_from_response(&text).ok_or_else(|| {
        CoreError::Internal("会话标题响应缺少 choices[0].message.content（非空文本）".to_string())
    })?;
    let title = sanitize_generated_session_title(&content)
        .ok_or_else(|| CoreError::Internal("会话标题清洗后为空".to_string()))?;
    Ok(GenerateSessionTitleResult { title })
}

/// 任一侧在截断后仍有可见文本即可发请求。
pub(crate) fn session_title_has_input(user_text: &str, assistant_text: &str) -> bool {
    !capped_side(user_text).is_empty() || !capped_side(assistant_text).is_empty()
}

/// 单条 user 消息的标题提示词。两侧各自先 trim 再按码点截断。
pub(crate) fn build_session_title_prompt(user_text: &str, assistant_text: &str) -> String {
    let user = capped_side(user_text);
    let assistant = capped_side(assistant_text);
    format!(
        "请为下面这段对话生成一个不超过12个汉字的标题。只输出标题本身，不要引号、标点或解释。\n用户：{user}\n助手：{assistant}"
    )
}

/// 标题请求体：非流式、小 `max_tokens`、无 tools、无缓存键。
pub(crate) fn build_session_title_request_body(
    config: &EngineProviderConfig,
    user_text: &str,
    assistant_text: &str,
) -> serde_json::Value {
    let options = ChatCompletionsRequestOptions {
        model: Some(config.model.clone()),
        stream: Some(false),
        max_tokens: Some(SESSION_TITLE_MAX_TOKENS),
        max_tokens_field: Some(max_tokens_field(config)),
        cache: None,
        ..ChatCompletionsRequestOptions::default()
    };
    let message = user_message(&build_session_title_prompt(user_text, assistant_text), None);
    let message_arc = Arc::new(message);
    let context = RequestBuildContext {
        system_prompt: None,
        messages: std::slice::from_ref(&message_arc),
        tools: Vec::new(),
        wire_mode: SystemPromptWireMode::NativeSystemRole,
    };
    build_chat_completions_request_body(&options, &context)
}

/// 去掉引号、标点和换行，再留下最多 12 个码点。空结果表示调用方应保留原标题。
pub(crate) fn sanitize_generated_session_title(raw: &str) -> Option<String> {
    let mut cleaned = String::new();
    for ch in raw.chars() {
        if is_title_noise(ch) {
            continue;
        }
        cleaned.push(ch);
    }
    let title: String = cleaned
        .trim()
        .chars()
        .take(SESSION_TITLE_MAX_CHARS)
        .collect();
    let title = title.trim().to_string();
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

fn capped_side(text: &str) -> String {
    text.trim().chars().take(SESSION_TITLE_INPUT_CAP).collect()
}

/// 引号、换行和 Unicode 标点。与前端 `sanitizeAiSessionTitle` 的 `\p{P}` 对齐到
/// 标题会碰到的 ASCII / 通用标点 / CJK 标点；符号（字母、数字、空格）保留。
fn is_title_noise(ch: char) -> bool {
    if ch.is_ascii_punctuation() || ch == '\n' || ch == '\r' || ch == '\u{2028}' || ch == '\u{2029}'
    {
        return true;
    }
    matches!(
        ch,
        '\u{00A1}' | '\u{00A7}' | '\u{00AB}' | '\u{00B7}' | '\u{00BB}' | '\u{00BF}'
            | '\u{2010}'..='\u{2027}'
            | '\u{2030}'..='\u{205E}'
            | '\u{2E00}'..='\u{2E7F}'
            | '\u{3001}'..='\u{3003}'
            | '\u{3008}'..='\u{301F}'
            | '\u{3030}'
            | '\u{303D}'
            | '\u{FF01}'..='\u{FF0F}'
            | '\u{FF1A}'..='\u{FF20}'
            | '\u{FF3B}'..='\u{FF40}'
            | '\u{FF5B}'..='\u{FF65}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> EngineProviderConfig {
        EngineProviderConfig {
            model: "session-title-unit".to_string(),
            base_url: "https://example.invalid/v1".to_string(),
            ..EngineProviderConfig::default()
        }
    }

    #[test]
    fn sanitize_generated_session_title_strips_quotes_punctuation_and_truncates() {
        assert_eq!(
            sanitize_generated_session_title("\"登录问题\"").as_deref(),
            Some("登录问题")
        );
        assert_eq!(
            sanitize_generated_session_title("「你好，世界！」").as_deref(),
            Some("你好世界")
        );
        assert_eq!(
            sanitize_generated_session_title("第一行\n第二行").as_deref(),
            Some("第一行第二行")
        );
        assert_eq!(
            sanitize_generated_session_title("  ‘一二三四五六七八九十甲乙丙’  ").as_deref(),
            Some("一二三四五六七八九十甲乙")
        );
        assert_eq!(sanitize_generated_session_title("！！！"), None);
        assert_eq!(sanitize_generated_session_title(" \n\t "), None);
    }

    #[test]
    fn build_session_title_prompt_caps_each_side() {
        let user = "测".repeat(450);
        let prompt = build_session_title_prompt(&user, "  答  ");
        assert_eq!(prompt.matches('测').count(), SESSION_TITLE_INPUT_CAP);
        assert!(prompt.contains("助手：答"));
        assert!(prompt.contains("不超过12个汉字"));
        assert!(!session_title_has_input("  ", "\n"));
        assert!(session_title_has_input("", "有回复"));
    }

    #[test]
    fn build_session_title_request_body_is_one_user_message_without_tools_or_cache() {
        let body = build_session_title_request_body(&test_config(), "用户侧原文", "助手侧原文");
        assert_eq!(body["model"].as_str(), Some("session-title-unit"));
        assert_eq!(body["stream"].as_bool(), Some(false));
        let max_tokens = body
            .get("max_tokens")
            .or_else(|| body.get("max_completion_tokens"))
            .or_else(|| body.get("max_output_tokens"));
        assert_eq!(max_tokens.and_then(|value| value.as_u64()), Some(64));
        assert!(body.get("tools").is_none());
        assert!(body.get("tool_choice").is_none());
        assert!(body.get("prompt_cache_key").is_none());
        assert!(body.get("prompt_cache_retention").is_none());
        assert!(body.get("prompt_cache_options").is_none());
        let messages = body["messages"].as_array().expect("messages");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"].as_str(), Some("user"));
        let blob = messages[0].to_string();
        assert!(blob.contains("用户侧原文"));
        assert!(blob.contains("助手侧原文"));
        assert!(blob.contains("不超过12个汉字"));
    }

    #[test]
    fn summary_content_then_sanitize_matches_title_rules() {
        let raw = r#"{"choices":[{"message":{"content":"\"登录问题排查！\""}}]}"#;
        let content = summary_content_from_response(raw).expect("content");
        assert_eq!(
            sanitize_generated_session_title(&content).as_deref(),
            Some("登录问题排查")
        );
        assert!(summary_content_from_response(r#"{"choices":[]}"#).is_none());
    }
}
