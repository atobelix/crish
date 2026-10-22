use conex_types::response::ProviderOutput;
use crate::events::{ProviderStreamEvent, ProviderUsage, StopReason};

mod aggregation;
mod stop_reasons;

pub(crate) fn text_delta(text: &str) -> ProviderStreamEvent {
    ProviderStreamEvent::TextDelta {
        text: text.to_string(),
    }
}

pub(crate) fn thought_delta(text: &str, redacted: Option<bool>) -> ProviderStreamEvent {
    ProviderStreamEvent::ThoughtDelta {
        text: text.to_string(),
        redacted,
    }
}

pub(crate) fn tool_call(id: Option<&str>, name: &str) -> ProviderStreamEvent {
    ProviderStreamEvent::ToolCall {
        id: id.map(str::to_string),
        tool_name: name.to_string(),
        input: serde_json::json!({ "path": "/tmp/a" }),
    }
}

pub(crate) fn stop(reason: StopReason) -> ProviderStreamEvent {
    stop_with(reason, None, None)
}

pub(crate) fn stop_with(
    reason: StopReason,
    error: Option<&str>,
    usage: Option<ProviderUsage>,
) -> ProviderStreamEvent {
    ProviderStreamEvent::Stop {
        reason,
        error: error.map(str::to_string),
        error_kind: None,
        usage,
    }
}

pub(crate) fn message(response: &ProviderOutput) -> &ProviderOutput {
    assert!(response.is_message(), "应为 Message，得到 {response:?}");
    response
}
