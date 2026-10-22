use super::{diagnostic_event, stop_event, text_event};
use crate::events::{ProviderStreamEvent, StopReason, StreamParseError, StreamParser};

#[test]
fn parser_accepts_single_stop() {
    let mut parser = StreamParser::new();
    assert!(!parser.is_stopped());
    parser.push(text_event()).unwrap();
    parser.push(stop_event(StopReason::Stop)).unwrap();
    assert!(parser.is_stopped());
}

#[test]
fn parser_rejects_duplicate_stop() {
    let mut parser = StreamParser::new();
    parser.push(stop_event(StopReason::Stop)).unwrap();
    let error = parser.push(stop_event(StopReason::Error)).unwrap_err();
    assert_eq!(error, StreamParseError::DuplicateStop);
}

#[test]
fn parser_rejects_event_after_stop() {
    let mut parser = StreamParser::new();
    parser.push(stop_event(StopReason::Length)).unwrap();
    assert_eq!(
        parser.push(text_event()).unwrap_err(),
        StreamParseError::EventAfterStop
    );
    assert_eq!(
        parser
            .push(ProviderStreamEvent::ToolCall {
                id: None,
                tool_name: "x".into(),
                input: serde_json::json!({}),
            })
            .unwrap_err(),
        StreamParseError::EventAfterStop
    );
    assert!(parser.is_stopped());
}

#[test]
fn parser_allows_diagnostics_anytime_before_stop() {
    let mut parser = StreamParser::new();
    parser.push(diagnostic_event()).unwrap();
    parser.push(text_event()).unwrap();
    parser.push(diagnostic_event()).unwrap();
    parser.push(stop_event(StopReason::Stop)).unwrap();
    assert!(parser.is_stopped());
}

#[test]
fn parser_extend_stops_at_first_error() {
    let mut parser = StreamParser::new();
    let events = vec![text_event(), stop_event(StopReason::Stop), text_event()];
    let error = parser.extend(events).unwrap_err();
    assert_eq!(error, StreamParseError::EventAfterStop);
    assert!(parser.is_stopped());
}

#[test]
fn parser_extend_empty_is_ok() {
    let mut parser = StreamParser::new();
    parser.extend(Vec::<ProviderStreamEvent>::new()).unwrap();
    assert!(!parser.is_stopped());
}

#[test]
fn parser_check_events_validates_borrowed() {
    let mut parser = StreamParser::new();
    let events = vec![text_event(), stop_event(StopReason::Stop)];
    parser.check_events(&events).unwrap();
    assert!(parser.is_stopped());
    let bad = vec![text_event()];
    assert_eq!(
        parser.check_events(&bad).unwrap_err(),
        StreamParseError::EventAfterStop
    );
}
