use super::*;
use conex_types::tool::ProviderDiagnostic;

mod stream;
mod usage;
mod wire;

pub(crate) fn text_event() -> ProviderStreamEvent {
    ProviderStreamEvent::TextDelta {
        text: "你好".into(),
    }
}

pub(crate) fn stop_event(reason: StopReason) -> ProviderStreamEvent {
    ProviderStreamEvent::Stop {
        reason,
        error: None,
        error_kind: None,
        usage: None,
    }
}

pub(crate) fn diagnostic_event() -> ProviderStreamEvent {
    ProviderStreamEvent::ProviderDiagnostic {
        diagnostic: ProviderDiagnostic {
            phase: conex_types::tool::ProviderDiagnosticPhase::SseFirstByte,
            ..ProviderDiagnostic::default()
        },
    }
}
